// SPDX-License-Identifier: MPL-2.0

import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as readline from "node:readline";
import { version as extensionVersion } from "../package.json";

type Arguments = Record<string, unknown>;

export const clipProperties = {
  waveform: {
    type: "string",
    description:
      "Absolute path of an open waveform. Defaults to the active view.",
  },
  signals: {
    type: "array",
    items: { type: "string" },
    minItems: 1,
    maxItems: 64,
    description:
      "Full signal paths. Defaults to selected signal rows, or displayed rows if none are selected.",
  },
  range: {
    type: "string",
    enum: ["view", "cursors", "explicit"],
    description:
      "Visible time window, A/B cursor interval, or explicit tick bounds.",
  },
  start: {
    type: "string",
    description:
      "Start tick, as an integer string. Together with end, defaults to explicit range.",
  },
  end: { type: "string", description: "End tick, as an integer string." },
  limit: {
    type: "integer",
    minimum: 1,
    maximum: 5000,
    description:
      "Maximum events per signal before the total clip budget is applied.",
  },
};
type InputProperty = {
  type: string;
  enum?: readonly string[];
  minimum?: number;
  maximum?: number;
  minItems?: number;
  maxItems?: number;
  items?: { type: string };
  description?: string;
};

function validArgument(value: unknown, property: InputProperty) {
  if (property.type === "boolean") return typeof value === "boolean";
  if (property.type === "object")
    return !!value && typeof value === "object" && !Array.isArray(value);
  if (property.type === "string")
    return (
      typeof value === "string" &&
      value.length > 0 &&
      (!property.enum || property.enum.includes(value))
    );
  if (property.type === "integer")
    return (
      typeof value === "number" &&
      Number.isSafeInteger(value) &&
      value >= (property.minimum ?? -Infinity) &&
      value <= (property.maximum ?? Infinity)
    );
  return (
    property.type === "array" &&
    Array.isArray(value) &&
    value.length >= (property.minItems ?? 0) &&
    value.length <= (property.maxItems ?? Infinity) &&
    value.every(
      (item) => typeof item === property.items?.type && item.length > 0,
    )
  );
}

export function tool(
  name: string,
  description: string,
  properties: Record<string, InputProperty>,
  required: string[],
) {
  return {
    name,
    description,
    inputSchema: {
      type: "object",
      properties,
      required,
      additionalProperties: false,
    },
  };
}

export function validateCall(
  definitions: readonly ReturnType<typeof tool>[],
  name: string,
  args: Arguments,
) {
  const definition = definitions.find((entry) => entry.name === name);
  if (!definition || !args || typeof args !== "object" || Array.isArray(args))
    throw Error("Invalid Wave Workbench tool call");
  if (
    definition.inputSchema.required.some((key) => !Object.hasOwn(args, key)) ||
    Object.keys(args).some(
      (key) =>
        !Object.hasOwn(definition.inputSchema.properties, key) ||
        !validArgument(args[key], definition.inputSchema.properties[key]),
    )
  )
    throw Error("Invalid Wave Workbench tool arguments");
}

export function socketDirectory(workspace: string) {
  const id = createHash("sha256")
    .update(fs.realpathSync(workspace))
    .digest("hex")
    .slice(0, 20);
  const uid = process.getuid?.();
  const name =
    uid === undefined ? "wave-workbench-" + id : `wave-workbench-${uid}-${id}`;
  let directory = path.join(os.tmpdir(), name);
  if (
    process.platform !== "win32" &&
    Buffer.byteLength(path.join(directory, "00000000000.sock")) > 100
  )
    directory = path.join("/tmp", name);
  try {
    fs.mkdirSync(directory, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const info = fs.lstatSync(directory);
  if (
    !info.isDirectory() ||
    (uid !== undefined && (info.uid !== uid || info.mode & 0o077))
  )
    throw Error(
      "Wave Workbench socket directory must be private and owned by the current user",
    );
  return directory;
}

export async function serveMcpStdio(
  serverName: string,
  definitions: readonly ReturnType<typeof tool>[],
  call: (
    name: string,
    args: Arguments,
    signal: AbortSignal,
  ) => Promise<unknown>,
) {
  const supportedVersions = [
    "2025-11-25",
    "2025-06-18",
    "2025-03-26",
    "2024-11-05",
  ];
  const pending = new Map<string | number, AbortController>();
  let tools = Promise.resolve();
  for await (const line of readline.createInterface({ input: process.stdin })) {
    let request;
    try {
      request = JSON.parse(line);
    } catch {
      process.stdout.write(
        JSON.stringify({
          jsonrpc: "2.0",
          id: null,
          error: { code: -32700, message: "Invalid JSON" },
        }) + "\n",
      );
      continue;
    }
    if (!request || typeof request !== "object") continue;
    if (
      request.method === "notifications/cancelled" &&
      !Object.hasOwn(request, "id")
    ) {
      pending.get(request.params?.requestId)?.abort();
      continue;
    }
    if (!Object.hasOwn(request, "id")) continue;
    const response: Arguments = { jsonrpc: "2.0", id: request.id };
    if (request.method === "initialize") {
      const version = request.params?.protocolVersion;
      response.result = {
        protocolVersion: supportedVersions.includes(version)
          ? version
          : supportedVersions[0],
        capabilities: { tools: {} },
        serverInfo: { name: serverName, version: extensionVersion },
      };
    } else if (request.method === "ping") response.result = {};
    else if (request.method === "tools/list")
      response.result = { tools: definitions };
    else if (request.method === "tools/call") {
      const id = request.id as string | number;
      if (pending.has(id)) continue;
      const operation = new AbortController();
      pending.set(id, operation);
      const params = request.params;
      tools = tools.then(async () => {
        try {
          if (operation.signal.aborted) return;
          const args = params?.arguments ?? {};
          validateCall(definitions, params?.name, args);
          const result = await call(params.name, args, operation.signal);
          if (
            params?.name === "wave_export" &&
            result &&
            typeof result === "object" &&
            "imagePng" in result &&
            typeof result.imagePng === "string"
          ) {
            const { imagePng, ...metadata } = result;
            response.result = {
              content: [
                { type: "text", text: JSON.stringify(metadata) },
                { type: "image", mimeType: "image/png", data: imagePng },
              ],
            };
          } else {
            response.result = {
              content: [{ type: "text", text: JSON.stringify(result) }],
            };
          }
        } catch (error) {
          response.result = {
            isError: true,
            content: [{ type: "text", text: String(error) }],
          };
        } finally {
          pending.delete(id);
        }
        if (!operation.signal.aborted)
          process.stdout.write(JSON.stringify(response) + "\n");
      });
      continue;
    } else response.error = { code: -32601, message: "Method not found" };
    process.stdout.write(JSON.stringify(response) + "\n");
  }
  await tools;
}
