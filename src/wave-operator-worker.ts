// SPDX-License-Identifier: MPL-2.0

import { parentPort, workerData } from "node:worker_threads";
import { pathToFileURL } from "node:url";
import { validateOperatorOutput, type WaveOperator } from "./wave-operator";

async function run() {
  try {
    const { entry, request } = workerData;
    const { default: operator } = (await import(pathToFileURL(entry).href)) as {
      default: WaveOperator;
    };
    if (typeof operator !== "function")
      throw Error("算子模块必须默认导出一个函数。");
    const result = validateOperatorOutput(await operator(request), request);
    parentPort!.postMessage({ result });
  } catch (error) {
    parentPort!.postMessage({ error: String(error).slice(0, 4096) });
  }
}

void run();
