// SPDX-License-Identifier: MPL-2.0
import type {
  DesignHierarchicalAccess,
  DesignInterfaceUser,
  DesignPortLink,
  DesignSession,
} from "./kdb";
import type {
  AssignmentValue,
  GenerateLabel,
  GuardExpression,
  TraceDirection,
  TraceOptions,
  VideTrace,
} from "./rtl-trace";
import { evaluateTraceValue, traceInteger } from "./rtl-trace-values";
import {
  portSources,
  type DesignPortEndpoint as Port,
  type Location,
} from "./shared/protocol";

export type TracePortQuery = (
  port: Port,
  depth: number,
  direction?: TraceDirection,
  site?: DesignHierarchicalAccess | DesignInterfaceUser,
) => Promise<VideTrace | undefined>;

export async function seedModportAlias(
  anchor: VideTrace,
  alias: Port,
  declaration: TraceLocation,
  members: Location[],
  direction: TraceDirection,
  options: TraceOptions,
  sourceUri: (file: string) => string,
  query: TracePortQuery,
): Promise<VideTrace> {
  const root = {
    instance: alias.instance,
    id: 0,
    name: alias.signal,
    declaration,
    signed: false,
    modportAlias: true as const,
  };
  const trace: VideTrace = {
    ...anchor,
    scope: "elaborated",
    root: root.id,
    signals: [root],
    assignments: [],
    frontier: [],
  };
  const slots = new Map<string, VideTrace["signals"][number]>();
  const signalCount = new Set(members.map(({ fullname }) => fullname)).size + 1;
  const assignmentCount = direction === "loads" ? members.length : 1;
  const budget =
    options.maxDepth === 0
      ? "depth"
      : signalCount > (options.maxSignals ?? 256)
        ? "signals"
        : assignmentCount > (options.maxAssignments ?? 512)
          ? "assignments"
          : undefined;
  if (budget) {
    trace.frontier.push({ signal: root.id, reason: budget });
    return trace;
  }

  const assignment = (targets: number[], value: AssignmentValue) => ({
    kind: "port" as const,
    location: declaration,
    targets,
    hasUnresolvedOperands: false,
    value,
    port: { expression: true as const, modportAlias: true as const },
  });
  const input = (signal: number, interfaceRange?: [number, number]) => ({
    signal,
    kind: "data" as const,
    edge: null,
    location: declaration,
    interfaceRange,
  });
  const operands: AssignmentValue[] = [];
  const reads: ReturnType<typeof input>[] = [];
  let remaining = members.reduce(
    (size, member) => size + member.interfaceWidth!,
    0,
  );
  for (const member of members) {
    let source = slots.get(member.fullname);
    if (!source) {
      const name = member.fullname.slice(member.instance.length + 1);
      const entry = await query({ instance: member.instance, signal: name }, 0);
      const signal = entry?.signals.find(({ id }) => id === entry.root);
      if (
        signal?.name !== name ||
        signal.declaration?.uri !== sourceUri(member.file) ||
        signal.declaration.range.start.line !== member.line - 1
      )
        throw Error(
          "Could not verify the RTL declaration for " + member.fullname,
        );
      if (entry.revision !== anchor.revision)
        throw Error("RTL changed during the instance trace.");
      source = {
        ...signal,
        instance: member.instance,
        id: trace.signals.length,
      };
      slots.set(member.fullname, source);
      trace.signals.push(source);
    }
    const range = member.interfaceRange;
    if (direction === "drivers") {
      reads.push(input(source.id, range));
      operands.push(
        range
          ? { op: "select", args: [source.id, ...range] }
          : { op: "signal", args: source.id },
      );
    } else {
      const left = remaining - 1;
      remaining -= member.interfaceWidth!;
      trace.assignments.push({
        ...assignment([source.id], {
          op: "select",
          args: [root.id, left, remaining],
        }),
        inputs: [input(root.id, [left, remaining])],
        targetRange: range,
      });
    }
  }
  if (direction === "drivers")
    trace.assignments.push({
      ...assignment([root.id], { op: "concat", args: operands }),
      inputs: reads,
    });
  return trace;
}

function remap(
  expression: GuardExpression,
  ids: Map<number, number>,
  scopedIds?: ReadonlyMap<number | string, number>,
  generateIndices?: ReadonlyMap<string, number>,
): GuardExpression | null {
  if (expression.op === "signal") {
    const id = ids.get(expression.args);
    return id === undefined ? null : { op: "signal", args: id };
  }
  if (expression.op === "not") {
    const value = remap(expression.args, ids, scopedIds, generateIndices);
    return value && { op: "not", args: value };
  }
  if (expression.op === "value") {
    const value = remapValue(expression.args, ids, scopedIds, generateIndices);
    return value ? { op: "value", args: value } : null;
  }
  const left = remap(expression.args[0], ids, scopedIds, generateIndices);
  const right = remap(expression.args[1], ids, scopedIds, generateIndices);
  return left && right && { op: expression.op, args: [left, right] };
}

function componentKey(offset: number, component: number) {
  return offset + ":" + component;
}

function remapValue(
  node: AssignmentValue,
  ids: Pick<ReadonlyMap<number, number>, "get">,
  scopedIds?: ReadonlyMap<number | string, number>,
  generateIndices?: ReadonlyMap<string, number>,
): AssignmentValue | undefined {
  const remapChild = (child: AssignmentValue) =>
    remapValue(child, ids, scopedIds, generateIndices);
  switch (node.op) {
    case "signal": {
      const id = ids.get(node.args);
      return id === undefined ? undefined : { op: "signal", args: id };
    }
    case "scopedSignal": {
      const id = scopedIds?.get(node.args[1]);
      if (!scopedIds && generateIndices) {
        const signal = ids.get(node.args[0]);
        return signal === undefined
          ? undefined
          : { op: "scopedSignal", args: [signal, node.args[1]] };
      }
      return id === undefined ? undefined : { op: "signal", args: id };
    }
    case "scopedSelect": {
      const [signal, offset, left, right] = node.args;
      if (!scopedIds && generateIndices) {
        const id = ids.get(signal);
        return id === undefined
          ? undefined
          : { op: "scopedSelect", args: [id, offset, left, right] };
      }
      const id = scopedIds?.get(offset);
      return id === undefined
        ? undefined
        : { op: "select", args: [id, left, right] };
    }
    case "scopedComponent": {
      const [signal, offset, component, range] = node.args;
      if (!scopedIds && generateIndices) {
        const id = ids.get(signal);
        return id === undefined
          ? undefined
          : { op: "scopedComponent", args: [id, offset, component, range] };
      }
      const id = scopedIds?.get(componentKey(offset, component));
      if (id === undefined) return;
      return range
        ? { op: "select", args: [id, ...range] }
        : { op: "signal", args: id };
    }
    case "slice": {
      const [value, left, right] = node.args;
      const remapped = remapChild(value);
      return remapped && { op: "slice", args: [remapped, left, right] };
    }
    case "generateIndex": {
      if (!generateIndices) return node;
      const index = generateIndices.get(node.args);
      if (index === undefined) return;
      const bits = BigInt.asUintN(32, BigInt(index))
        .toString(2)
        .padStart(32, "0");
      return { op: "literal", args: [bits, true] };
    }
    case "select": {
      const [old, left, right] = node.args;
      const id = ids.get(old);
      return id === undefined
        ? undefined
        : { op: "select", args: [id, left, right] };
    }
    case "boundSelect": {
      const [old, first, last] = node.args;
      const id = ids.get(old);
      const left = remapChild(first);
      const right = remapChild(last);
      return id === undefined || !left || !right
        ? undefined
        : { op: "boundSelect", args: [id, left, right] };
    }
    case "bitSelect":
    case "indexedPartSelect": {
      const id = ids.get(node.args[0]);
      const index = remapChild(node.args[1]);
      if (id === undefined || index === undefined) return undefined;
      return node.op === "bitSelect"
        ? { op: "bitSelect", args: [id, index] }
        : { op: "indexedPartSelect", args: [id, index, node.args[2]] };
    }
    case "unary": {
      const [operator, child] = node.args;
      const value = remapChild(child);
      return value && { op: "unary", args: [operator, value] };
    }
    case "binary": {
      const [operator, first, second] = node.args;
      const left = remapChild(first);
      const right = remapChild(second);
      return left && right && { op: "binary", args: [operator, left, right] };
    }
    case "conditional": {
      const [condition, yes, no] = node.args.map(remapChild);
      return (
        condition &&
        yes &&
        no && { op: "conditional", args: [condition, yes, no] }
      );
    }
    case "concat": {
      const parts = node.args.map(remapChild);
      return parts.every((part) => part !== undefined)
        ? { op: "concat", args: parts }
        : undefined;
    }
    case "repeat": {
      const [count, part] = node.args;
      const value = remapChild(part);
      return value && { op: "repeat", args: [count, value] };
    }
    case "cast": {
      const [width, signed, twoState, input] = node.args;
      const value = remapChild(input);
      return value && { op: "cast", args: [width, signed, twoState, value] };
    }
    default:
      return node;
  }
}

export async function expandInstanceTrace(
  initial: VideTrace,
  instance: string,
  design: DesignSession,
  direction: TraceDirection,
  options: TraceOptions,
  sourceUri: (file: string) => string,
  query: TracePortQuery,
  designMatches: boolean | "unverifiedVcsParameterPath" = true,
  rootElement?: number,
) {
  if (designMatches !== true)
    return {
      ...initial,
      frontier: [
        ...initial.frontier,
        {
          signal: initial.root,
          reason: designMatches === false ? "mismatchedDesign" : designMatches,
        },
      ],
    };
  if (!instance || !design.portLinks) return initial;
  const result: VideTrace = {
    ...initial,
    scope: "elaborated",
    signals: [],
    assignments: [],
    frontier: [],
    diagnostics: [
      ...initial.diagnostics,
      design.kind === "kdb" ? "kdbPortLinks" : "verilatorPortLinks",
    ],
  };
  const signalLimit = options.maxSignals ?? 256;
  const assignmentLimit = options.maxAssignments ?? 512;
  // The order in which local traces return is different from the distance
  // from the overall root, especially when a local trace has many branches.
  const discoverySignalLimit = Math.max(
    signalLimit,
    Math.min(signalLimit * 3, 4096),
  );
  const discoveryAssignmentLimit = Math.max(
    assignmentLimit,
    Math.min(assignmentLimit * 3, 12288),
  );
  const ids = new Map<string, number>();
  const ports = new Map<string, number>();
  const queried = new Map<string, number>();
  const visited = new Map<number, number>();
  const assignments = new Set<string>();
  const interfaceSites = new Set<string>();
  const siteKey = (signal: number, location: TraceLocation, write: boolean) =>
    JSON.stringify([signal, location.uri, location.range.start, write]);
  const pending: {
    trace: VideTrace;
    instance: string;
    depth: number;
    bound?: true;
  }[] = [{ trace: initial, instance, depth: options.maxDepth ?? 32 }];
  const links: { local: number; link: DesignPortLink }[] = [];
  const key = (port: Port) => port.instance + "\0" + port.signal;
  const portLocation = ({
    file,
    line,
  }: {
    file: string;
    line: number;
  }): TraceLocation => ({
    uri: sourceUri(file),
    range: { start: { line: line - 1, character: 0 } },
  });
  async function matchesPortDeclaration(
    { instance, signal }: Port,
    declaration: VideTrace["signals"][number]["declaration"],
  ) {
    if (!declaration) return false;
    const object = await design
      .resolve(instance + "." + signal)
      .catch(() => undefined);
    return (
      !!object?.file &&
      object.instance === instance &&
      object.line === declaration.range.start.line + 1 &&
      sourceUri(object.file) === declaration.uri
    );
  }

  function addAssignment(
    assignment: VideTrace["assignments"][number],
    frontier: number,
  ) {
    const start = assignment.location.range.start;
    const key = JSON.stringify([
      assignment.location.uri,
      start,
      assignment.instance,
      assignment.targets,
      assignment.targetRange,
      assignment.hierarchicalTargets,
      assignment.inputs,
      assignment.port,
    ]);
    if (assignments.has(key)) return;
    if (result.assignments.length >= discoveryAssignmentLimit) {
      result.frontier.push({ signal: frontier, reason: "assignments" });
      return;
    }
    assignments.add(key);
    result.assignments.push(assignment);
  }

  function addSignal(
    signal: VideTrace["signals"][number],
    instance: string,
    frontier: number,
  ) {
    const identity = JSON.stringify([
      signal.instance ?? instance,
      signal.name,
      signal.declaration,
    ]);
    const existing = ids.get(identity);
    if (existing !== undefined) {
      if (signal.parameterValue)
        result.signals[existing].parameterValue = signal.parameterValue;
      return existing;
    }
    if (result.signals.length >= discoverySignalLimit) {
      result.frontier.push({ signal: frontier, reason: "signals" });
      return undefined;
    }
    const id = result.signals.length;
    ids.set(identity, id);
    result.signals.push({
      ...signal,
      instance: signal.instance ?? instance,
      id,
    });
    return id;
  }

  for (let index = 0; index < pending.length; index++) {
    const { instance, depth, trace: local, bound } = pending[index];
    const generated = bound
      ? local
      : await bindKdbGenerateAssignments(
          local,
          instance,
          design,
          direction,
          sourceUri,
        );
    const selected = bound
      ? local
      : await resolveInterfacePaths(
          await applyGenerateBranches(
            generated,
            instance,
            design,
            direction,
            sourceUri,
          ),
          instance,
          design,
          sourceUri,
        );
    const operands = bound
      ? local
      : bindHierarchicalOperands(
          selected,
          instance,
          design,
          sourceUri,
          undefined,
          await interfaceBindings(selected, instance, design, sourceUri),
        );
    const scoped = bound
      ? operands
      : await bindKdbGenerateScope(operands, instance, design, sourceUri);
    const trace =
      index === 0 && direction === "drivers" && rootElement !== undefined
        ? selectRootElement(scoped, rootElement)
        : scoped;
    if (trace.revision !== initial.revision)
      throw Error("RTL changed during the instance trace.");
    if (
      options.includeCompilation &&
      JSON.stringify(trace.compilation) !== JSON.stringify(initial.compilation)
    ) {
      result.compilation = undefined;
      if (!result.diagnostics.includes("multipleCompilationProfiles"))
        result.diagnostics.push("multipleCompilationProfiles");
    }
    const mapping = new Map<number, number>();
    const root = trace.signals.find(({ id }) => id === trace.root);
    if (!root) continue;
    const remaining = trace.signals.filter((signal) => signal !== root);
    for (const signal of [root, ...remaining]) {
      const mapped = addSignal(
        signal,
        instance,
        mapping.get(root.id) ?? result.root,
      );
      if (mapped !== undefined) mapping.set(signal.id, mapped);
    }
    const rootId = mapping.get(root.id);
    if (rootId === undefined) continue;
    if (index === 0) {
      result.root = rootId;
      if (direction === "drivers" && rootElement !== undefined)
        result.signals[rootId].selectedElement = rootElement;
    }
    for (const assignment of trace.assignments) {
      const targets = assignment.targets.flatMap((id) =>
        mapping.has(id) ? [mapping.get(id)!] : [],
      );
      const inputs = assignment.inputs.flatMap((input) =>
        mapping.has(input.signal)
          ? [{ ...input, signal: mapping.get(input.signal)! }]
          : [],
      );
      if (
        targets.length !== assignment.targets.length ||
        inputs.length !== assignment.inputs.length
      )
        continue;
      const guards = assignment.guards?.map((guard) => ({
        ...guard,
        expression: guard.expression && remap(guard.expression, mapping),
      }));
      const targetIndex =
        assignment.targetIndex && remapValue(assignment.targetIndex, mapping);
      const value =
        assignment.value && (!assignment.targetIndex || targetIndex)
          ? remapValue(assignment.value, mapping)
          : undefined;
      addAssignment(
        {
          ...assignment,
          instance: assignment.instance ?? instance,
          targets,
          inputs,
          guards,
          value,
          wordRead: remapWordRead(assignment.wordRead, mapping),
          fieldRead: remapFieldRead(assignment.fieldRead, mapping),
          targetField: remapFieldRead(assignment.targetField, mapping),
          fieldValue:
            assignment.fieldValue && remapValue(assignment.fieldValue, mapping),
          targetIndex,
          targetElementIndex:
            assignment.targetElementIndex &&
            remapValue(assignment.targetElementIndex, mapping),
          elementValue:
            assignment.elementValue &&
            remapValue(assignment.elementValue, mapping),
          hierarchicalTargets: assignment.hierarchicalTargets?.flatMap(
            (target) => {
              const signal = mapping.get(target.signal);
              return signal === undefined ? [] : [{ ...target, signal }];
            },
          ),
        },
        rootId,
      );
    }
    for (const item of trace.frontier) {
      const signal = trace.signals.find(({ id }) => id === item.signal);
      const write = item.reason === "unresolvedHierarchicalWrite";
      if (
        signal &&
        item.location &&
        (write || item.reason === "unresolvedHierarchicalLoad")
      ) {
        const {
          uri,
          range: { start },
        } = item.location;
        // The expanded-design pass below follows every binding for this
        // source site and reports any that cannot be verified.
        if (
          design
            .hierarchicalAccessSites?.(signal.name)
            .some(
              (access) =>
                access.write === write &&
                sourceUri(access.file) === uri &&
                access.line === start.line + 1 &&
                access.column === (item.byteColumn ?? start.character) + 1,
            )
        )
          continue;
      }
      result.frontier.push({
        ...item,
        signal: mapping.get(item.signal) ?? rootId,
      });
    }
    for (const [signal, distance] of traceDistances(trace, direction)) {
      const id = mapping.get(signal);
      if (id === undefined) continue;
      if (result.signals[id].modportAlias) continue;
      const remainingDepth = depth - distance;
      const scoped = trace.signals.find(({ id }) => id === signal)?.instance;
      if (scoped && (!bound || signal !== trace.root)) {
        const remote = { instance: scoped, signal: result.signals[id].name };
        const identity = key(remote);
        if ((queried.get(identity) ?? -1) >= remainingDepth) continue;
        if (remainingDepth <= 0 || pending.length >= signalLimit) {
          result.frontier.push({
            signal: id,
            reason: remainingDepth <= 0 ? "depth" : "signals",
          });
          continue;
        }
        queried.set(identity, remainingDepth);
        const next = await query(remote, remainingDepth);
        if (next)
          pending.push({
            trace: next,
            instance: scoped,
            depth: remainingDepth,
          });
        else
          result.frontier.push({
            signal: id,
            reason:
              direction === "drivers"
                ? "unresolvedHierarchicalRead"
                : "unresolvedHierarchicalWrite",
          });
        continue;
      }
      if ((visited.get(id) ?? -1) >= remainingDepth) continue;
      visited.set(id, remainingDepth);
      const { name, declaration } = result.signals[id];
      const here = { instance: scoped ?? instance, signal: name };
      if (!declaration) continue;
      if (
        design.interfaceUsers &&
        (await design.resolve(here.instance).catch(() => undefined))?.kind ===
          "npiInterface"
      ) {
        const write = direction === "drivers";
        const reason = write
          ? "unresolvedHierarchicalWrite"
          : "unresolvedHierarchicalLoad";
        const users = await design
          .interfaceUsers(here.instance, name)
          .catch(() => {
            result.frontier.push({ signal: id, reason });
            return [];
          });
        for (const user of users) {
          if (remainingDepth <= 0 || pending.length >= signalLimit) {
            result.frontier.push({
              signal: id,
              reason: remainingDepth <= 0 ? "depth" : "signals",
            });
            break;
          }
          const raw = await query(here, remainingDepth, direction, user);
          if (!raw) {
            result.frontier.push({ signal: id, reason });
            continue;
          }
          if (!raw.assignments.length && !raw.frontier.length) continue;
          const generated = await bindKdbGenerateAssignments(
            raw,
            user.instance,
            design,
            direction,
            sourceUri,
          );
          const selected = selectInterfaceAssignments(
            await resolveInterfacePaths(
              generated,
              user.instance,
              design,
              sourceUri,
            ),
            direction,
            user.interfacePath,
          );
          if (!selected.assignments.length && !selected.frontier.length)
            continue;
          const relation = bindHierarchicalOperands(
            selected,
            user.instance,
            design,
            sourceUri,
            here,
            await interfaceBindings(selected, user.instance, design, sourceUri),
          );
          const root = relation.signals.find(({ id }) => id === relation.root);
          if (
            root?.instance !== here.instance ||
            JSON.stringify(root.declaration) !== JSON.stringify(declaration)
          ) {
            result.frontier.push({ signal: id, reason });
            continue;
          }
          for (const assignment of relation.assignments) {
            const operands = write
              ? assignment.hierarchicalTargets
              : assignment.inputs;
            for (const operand of operands ?? [])
              if (
                operand.signal === root.id &&
                operand.interfacePath === user.interfacePath
              )
                interfaceSites.add(siteKey(id, operand.location, write));
          }
          pending.push({
            trace: relation,
            instance: user.instance,
            depth: remainingDepth,
            bound: true,
          });
        }
      }
      if (direction === "drivers") {
        for (const write of design.hierarchicalWriters?.(here.instance, name) ??
          []) {
          if (remainingDepth <= 0 || pending.length >= signalLimit) {
            result.frontier.push({
              signal: id,
              reason: remainingDepth <= 0 ? "depth" : "signals",
            });
            continue;
          }
          const raw = await query(here, remainingDepth, "drivers", write);
          if (!raw) {
            result.frontier.push({
              signal: id,
              reason: "unresolvedHierarchicalWrite",
            });
            continue;
          }
          const active = await applyGenerateBranches(
            raw,
            write.owner,
            design,
            direction,
            sourceUri,
          );
          const relation = bindHierarchicalOperands(
            active,
            write.owner,
            design,
            sourceUri,
            here,
          );
          const root = relation.signals.find(({ id }) => id === relation.root);
          if (
            root?.instance === here.instance &&
            JSON.stringify(root.declaration) === JSON.stringify(declaration) &&
            relation.assignments.some((assignment) =>
              assignment.targets.includes(root.id),
            )
          )
            pending.push({
              trace: { ...relation, root: root.id },
              instance: write.owner,
              depth: remainingDepth,
              bound: true,
            });
          else
            result.frontier.push({
              signal: id,
              reason: "unresolvedHierarchicalWrite",
            });
        }
      }
      if (direction === "loads") {
        for (const read of design.hierarchicalConsumers?.(
          here.instance,
          name,
        ) ?? []) {
          const consumer = read.consumer;
          if (!consumer) {
            result.frontier.push({
              signal: id,
              reason: "unresolvedHierarchicalLoad",
            });
            continue;
          }
          if (remainingDepth <= 0 || pending.length + 1 >= signalLimit) {
            result.frontier.push({
              signal: id,
              reason: remainingDepth <= 0 ? "depth" : "signals",
            });
            continue;
          }
          const local = await query(consumer, 1, "drivers");
          const relation =
            local &&
            (await hierarchicalLoad(
              local,
              consumer.instance,
              read,
              declaration,
              design,
              sourceUri,
            ));
          if (!relation) {
            result.frontier.push({
              signal: id,
              reason: "unresolvedHierarchicalLoad",
            });
            continue;
          }
          pending.push({
            trace: relation,
            instance: consumer.instance,
            depth: remainingDepth,
            bound: true,
          });
          const remote = key(consumer);
          const nextDepth = remainingDepth - 1;
          if ((queried.get(remote) ?? -1) >= nextDepth) continue;
          queried.set(remote, nextDepth);
          const next = await query(consumer, nextDepth);
          if (next)
            pending.push({
              trace: next,
              instance: consumer.instance,
              depth: nextDepth,
            });
          else
            result.frontier.push({
              signal: id,
              reason: "unresolvedHierarchicalLoad",
            });
        }
      }
      const portLinks = await design
        .portLinks(here.instance, name)
        .catch(() => {
          result.frontier.push({ signal: id, reason: "unresolvedPortLinks" });
          return [];
        });
      if (
        await design.unresolvedPortExpression?.(here.instance, name, direction)
      )
        result.frontier.push({
          signal: id,
          reason: "unresolvedPortExpression",
        });
      const constant =
        direction === "drivers" &&
        (await design.constantPortDriver?.(here.instance, name));
      if (!portLinks.length && !constant) continue;
      const relevantLinks = portLinks.filter((link) => {
        const endpoints =
          direction === "drivers" ? [link.to] : portSources(link);
        return endpoints.some((endpoint) => key(endpoint) === key(here));
      });
      if (!(await matchesPortDeclaration(here, declaration))) {
        for (const link of relevantLinks)
          result.frontier.push({
            signal: id,
            reason: "unresolvedDesignSignal",
            location: portLocation(link),
          });
        if (constant)
          result.frontier.push({
            signal: id,
            reason: "unresolvedDesignSignal",
            location: portLocation(constant),
          });
        continue;
      }
      ports.set(key(here), id);
      if (constant) {
        if (remainingDepth <= 0)
          result.frontier.push({ signal: id, reason: "depth" });
        else
          addAssignment(
            {
              kind: "port",
              location: portLocation(constant),
              targets: [id],
              inputs: [],
              hasUnresolvedOperands: false,
              value: { op: "literal", args: [constant.bits, constant.signed] },
            },
            id,
          );
      }
      for (const link of relevantLinks) {
        const sources = portSources(link);
        if (remainingDepth <= 0) {
          result.frontier.push({ signal: id, reason: "depth" });
          continue;
        }
        links.push({ link, local: id });
        const nextDepth = remainingDepth - 1;
        for (const other of direction === "drivers" ? sources : [link.to]) {
          const remote = key(other);
          const known = ports.get(remote);
          if (
            (known !== undefined && (visited.get(known) ?? -1) >= nextDepth) ||
            (queried.get(remote) ?? -1) >= nextDepth
          )
            continue;
          if (pending.length >= signalLimit) {
            result.frontier.push({ signal: id, reason: "signals" });
            continue;
          }
          queried.set(remote, nextDepth);
          const next = await query(other, nextDepth);
          if (next)
            pending.push({
              trace: next,
              instance: other.instance,
              depth: nextDepth,
            });
        }
      }
    }
  }
  for (const { local, link } of links) {
    const to = ports.get(key(link.to));
    const location = portLocation(link);
    if (to === undefined) {
      result.frontier.push({
        signal: local,
        reason: "unresolvedPort",
        location,
      });
      continue;
    }
    const sources = portSources(link);
    if (direction === "loads" && sources.length > 1) {
      // A companion operand is required for the assignment, but its loads are
      // outside the fan-out of the queried signal.
      for (const operand of sources) {
        const port = key(operand);
        if (ports.has(port)) continue;
        if (result.signals.length >= discoverySignalLimit) {
          result.frontier.push({ signal: local, reason: "signals" });
          continue;
        }
        const trace = await query(operand, 0);
        if (trace && trace.revision !== initial.revision)
          throw Error("RTL changed during the instance trace.");
        const root = trace?.signals.find(({ id }) => id === trace.root);
        if (!root || !(await matchesPortDeclaration(operand, root.declaration)))
          continue;
        const id = addSignal(root, operand.instance, local);
        if (id !== undefined) ports.set(port, id);
      }
    }
    const inputs = sources.map((operand) => ports.get(key(operand)));
    const indexSignals = link.expression?.indexOperands
      ?.map((operand) => inputs[operand])
      .filter((id) => id !== undefined);
    const from = link.from && ports.get(key(link.from));
    const index = link.selectIndex && ports.get(key(link.selectIndex));
    const indexedPart = link.selectIndex?.part;
    if (inputs.some((id) => id === undefined))
      result.frontier.push({
        signal: local,
        reason: "unresolvedPort",
        location,
      });
    if (inputs.length && inputs.every((id) => id === undefined)) continue;
    const sourceRange =
      link.from?.range ??
      (link.from?.bit === undefined
        ? undefined
        : ([link.from.bit, link.from.bit] as const));
    const targetRange =
      link.to.range ??
      (link.to.bit === undefined
        ? undefined
        : ([link.to.bit, link.to.bit] as [number, number]));
    let value: AssignmentValue | undefined;
    if (link.expression) {
      const ids = new Map<number, number>();
      inputs.forEach((id, operand) => {
        if (id !== undefined) ids.set(operand, id);
      });
      value = remapValue(link.expression.value, ids);
    } else if (from !== undefined) {
      if (index !== undefined) {
        const indexValue = { op: "signal", args: index } as const;
        value = indexedPart
          ? { op: "indexedPartSelect", args: [from, indexValue, indexedPart] }
          : { op: "bitSelect", args: [from, indexValue] };
      } else if (sourceRange)
        value = { op: "select", args: [from, ...sourceRange] };
      else if (!link.selectIndex && (targetRange || link.conversion))
        value = { op: "signal", args: from };
    }
    if (value && link.conversion?.twoState)
      value = {
        op: "cast",
        args: [link.conversion.toWidth, false, true, value],
      };
    addAssignment(
      {
        kind: "port",
        location,
        targets: [to],
        inputs: [...new Set(inputs)]
          .filter((id) => id !== undefined)
          .map((signal) => ({ kind: "data", signal, edge: null, location })),
        hasUnresolvedOperands: inputs.some((id) => id === undefined),
        value: link.from?.field || link.to.field ? undefined : value,
        targetRange,
        port: {
          fromField: link.from?.field,
          toField: link.to.field,
          fromBit: link.from?.bit,
          toBit: link.to.bit,
          fromRange: link.from?.range,
          toRange: link.to.range,
          indexSignal: index,
          indexSignals: indexSignals?.length ? indexSignals : undefined,
          indexedPart,
          expression: link.expression ? true : undefined,
          conversion: link.conversion,
        },
      },
      local,
    );
  }
  const frontier: VideTrace["frontier"] = [];
  for (const item of result.frontier) {
    const { signal, location, reason, interfaceArrayAccess } = item;
    const write = reason === "unresolvedHierarchicalWrite";
    if (location && (write || reason === "unresolvedHierarchicalLoad")) {
      if (interfaceSites.has(siteKey(signal, location, write))) continue;
      const target = result.signals[signal];
      const interfaceMember = design.interfaceMember?.bind(design);
      if (
        interfaceArrayAccess &&
        target?.instance &&
        design.interfaceUsers &&
        interfaceMember
      ) {
        const { formal, memberPath } = interfaceArrayAccess;
        const formalName = memberPath.split("[", 1)[0];
        const users = await design
          .interfaceUsers(target.instance, target.name)
          .catch(() => []);
        const matching = users.filter(
          (user) =>
            sourceUri(user.file) === formal.uri &&
            user.line === formal.range.start.line + 1 &&
            user.interfacePath.startsWith(formalName + "["),
        );
        // An interface declaration is shared by all its elements. Drop a
        // lexical frontier only when the elaborated references point elsewhere.
        let otherElement = matching.length > 0;
        for (const { instance } of matching) {
          const bound = await interfaceMember(instance, memberPath).catch(
            () => undefined,
          );
          if (!bound?.instance || bound.instance === target.instance) {
            otherElement = false;
            break;
          }
        }
        if (otherElement) continue;
      }
    }
    frontier.push(item);
  }
  result.frontier = frontier;
  return limitInstanceTrace(result, direction, signalLimit, assignmentLimit);
}

function limitInstanceTrace(
  trace: VideTrace,
  direction: TraceDirection,
  signalLimit: number,
  assignmentLimit: number,
): VideTrace {
  if (
    trace.signals.length <= signalLimit &&
    trace.assignments.length <= assignmentLimit
  )
    return trace;

  const bySignal = new Map<number, number[]>();
  const members = trace.assignments.map(({ targets, inputs }, index) => {
    const reads = inputs.map(({ signal }) => signal);
    const upstream = direction === "drivers" ? reads : targets;
    const starts = direction === "drivers" ? targets : reads;
    for (const start of new Set(starts)) {
      const adjacent = bySignal.get(start) ?? [];
      adjacent.push(index);
      bySignal.set(start, adjacent);
    }
    return { signals: new Set([...targets, ...reads]), upstream };
  });
  const reached = new Set([trace.root]);
  const retainedSignals = new Set(reached);
  const retainedAssignments = new Set<number>();
  const frontier: VideTrace["frontier"] = [];
  for (const signal of reached) {
    for (const id of bySignal.get(signal) ?? []) {
      if (retainedAssignments.has(id)) continue;
      if (retainedAssignments.size >= assignmentLimit) {
        frontier.push({ signal, reason: "assignments" });
        break;
      }
      const { signals, upstream } = members[id];
      const newSignals = [...signals].filter((id) => !retainedSignals.has(id));
      if (retainedSignals.size + newSignals.length > signalLimit) {
        frontier.push({ signal, reason: "signals" });
        continue;
      }
      retainedAssignments.add(id);
      for (const member of newSignals) retainedSignals.add(member);
      for (const input of upstream) reached.add(input);
    }
  }
  return {
    ...trace,
    signals: trace.signals.filter(({ id }) => retainedSignals.has(id)),
    assignments: trace.assignments.filter((_, id) =>
      retainedAssignments.has(id),
    ),
    frontier: [
      ...trace.frontier.filter(({ signal }) => retainedSignals.has(signal)),
      ...frontier,
    ],
  };
}

type TraceLocation = VideTrace["assignments"][number]["location"];

async function bindKdbGenerateAssignments(
  trace: VideTrace,
  instance: string,
  design: DesignSession,
  direction: TraceDirection,
  sourceUri: (file: string) => string,
): Promise<VideTrace> {
  if (
    design.kind !== "kdb" ||
    !trace.assignments.some((assignment) =>
      assignment.generateBranches?.some(
        (branch) => branch.loopScope && branch.selected,
      ),
    )
  )
    return trace;

  const subject = await design.resolve(instance).catch(() => undefined);
  if (!subject) return trace;
  const module = subject.kind === "npiGenScope" ? subject.instance : instance;
  if (!module) return trace;

  const signals = new Map(trace.signals.map((signal) => [signal.id, signal]));
  const bindings = new Map<string, number | null>();
  const copies = new Map<number, number[]>();
  let nextSignal = trace.signals.reduce(
    (next, signal) => Math.max(next, signal.id + 1),
    0,
  );
  const assignments: VideTrace["assignments"] = [];
  const scopes = new Map<string, ReturnType<DesignSession["children"]>>();
  const sourceMatches = (
    label: GenerateLabel,
    record: Awaited<ReturnType<DesignSession["resolve"]>>,
  ) =>
    record?.file &&
    sourceUri(record.file) === label.uri &&
    record.line === label.line + 1;
  let scanBudget = 4096;

  async function owners(
    branches: NonNullable<VideTrace["assignments"][number]["generateBranches"]>,
  ) {
    let parents = [{ scope: module, indices: new Map<string, number>() }];
    for (const branch of branches) {
      const selected = branch.selected;
      if (!selected) return;
      const next = [];
      for (const { scope: parent, indices } of parents) {
        let children = scopes.get(parent);
        if (!children) {
          children = design.children(parent, true);
          scopes.set(parent, children);
        }
        const records = await children.catch(() => undefined);
        if (!records || records.length >= 1500) return;
        let found = false;
        let alternative = false;
        for (const child of records) {
          if (
            child.kind !== "npiGenScope" ||
            !child.fullname.startsWith(parent + ".")
          )
            continue;
          const name = child.fullname.slice(parent.length + 1);
          const iteration = branch.loopScope ? /\[(-?\d+)\]$/.exec(name) : null;
          const isSelected = branch.loopScope
            ? iteration && name.slice(0, iteration.index) === selected.name
            : name === selected.name;
          const label = isSelected
            ? selected
            : branch.alternatives.find((site) => site.name === name);
          if (!label) continue;
          if (--scanBudget < 0) return;
          const declaration = await design
            .resolve(child.fullname)
            .catch(() => undefined);
          if (!sourceMatches(label, declaration)) return;
          if (isSelected) {
            const locals = new Map(indices);
            if (iteration && branch.loopVariable) {
              const index = Number(iteration[1]);
              if (
                !Number.isInteger(index) ||
                index < -0x80000000 ||
                index > 0x7fffffff
              )
                return;
              locals.set(branch.loopVariable, index);
            }
            next.push({ scope: child.fullname, indices: locals });
            found = true;
          } else {
            alternative = true;
          }
        }
        if (found === alternative) return;
      }
      parents = next;
    }
    return parents;
  }

  async function bind(id: number, owner: string) {
    const signal = signals.get(id);
    if (!signal?.declaration) return;
    if (signal.instance) return id;
    for (
      let scope = owner;
      scope.length >= module.length;
      scope = scope.slice(0, scope.lastIndexOf("."))
    ) {
      const key = JSON.stringify([id, scope]);
      const cached = bindings.get(key);
      if (cached !== null) {
        if (cached !== undefined) return cached;
        if (--scanBudget < 0) return;
        const record = await design
          .resolve(scope + "." + signal.name)
          .catch(() => undefined);
        if (
          record?.instance === scope &&
          record.file &&
          sourceUri(record.file) === signal.declaration.uri &&
          record.line === signal.declaration.range.start.line + 1
        ) {
          const bound = instance === scope ? id : nextSignal++;
          bindings.set(key, bound);
          if (bound !== id) {
            signals.set(bound, { ...signal, id: bound, instance: scope });
            const items = copies.get(id) ?? [];
            items.push(bound);
            copies.set(id, items);
          }
          return bound;
        }
        bindings.set(key, null);
      }
      if (scope === module) break;
    }
  }

  for (const assignment of trace.assignments) {
    const branches = assignment.generateBranches;
    if (!branches?.some((branch) => branch.loopScope && branch.selected)) {
      assignments.push(assignment);
      continue;
    }
    const generatedOwners = await owners(branches);
    if (!generatedOwners) {
      assignments.push(assignment);
      continue;
    }
    const boundAssignments = [];
    const scoped = new Set([
      ...assignment.inputs
        .filter(({ hierarchical }) => hierarchical)
        .map(({ signal }) => signal),
      ...(assignment.hierarchicalTargets?.map(({ signal }) => signal) ?? []),
    ]);
    const participants = new Set([
      ...assignment.targets,
      ...assignment.inputs.map((input) => input.signal),
    ]);
    for (const { scope: owner, indices } of generatedOwners) {
      const ids = new Map<number, number>();
      for (const id of participants) {
        const bound = scoped.has(id) ? id : await bind(id, owner);
        if (bound !== undefined) ids.set(id, bound);
      }
      if (ids.size !== participants.size) break;
      const targetIndex =
        assignment.targetIndex &&
        remapValue(assignment.targetIndex, ids, undefined, indices);
      const constant =
        targetIndex &&
        evaluateTraceValue(targetIndex, undefined, () => undefined);
      const fixedBit = constant && traceInteger(constant.bits, constant.signed);
      const bit =
        !assignment.targetIndexedPart &&
        fixedBit !== undefined &&
        fixedBit >= -0x80000000n &&
        fixedBit <= 0x7fffffffn
          ? Number(fixedBit)
          : undefined;
      const value =
        assignment.value && (!assignment.targetIndex || targetIndex)
          ? remapValue(assignment.value, ids, undefined, indices)
          : undefined;
      const targetElementIndex =
        assignment.targetElementIndex &&
        remapValue(assignment.targetElementIndex, ids, undefined, indices);
      const elementValue =
        assignment.elementValue &&
        remapValue(assignment.elementValue, ids, undefined, indices);
      boundAssignments.push({
        ...assignment,
        instance: owner,
        generateBranches: undefined,
        generateIndices: indices.size ? Object.fromEntries(indices) : undefined,
        targets: assignment.targets.map((id) => ids.get(id)!),
        inputs: assignment.inputs.map((input) => ({
          ...input,
          signal: ids.get(input.signal)!,
          interfaceIndex:
            input.interfaceIndex && remapValue(input.interfaceIndex, ids),
        })),
        guards: assignment.guards?.map((guard) => ({
          ...guard,
          expression:
            guard.expression &&
            remap(guard.expression, ids, undefined, indices),
        })),
        value,
        wordRead: remapWordRead(assignment.wordRead, ids, undefined, indices),
        fieldRead: remapFieldRead(assignment.fieldRead, ids),
        targetField: remapFieldRead(assignment.targetField, ids),
        fieldValue:
          assignment.fieldValue &&
          remapValue(assignment.fieldValue, ids, undefined, indices),
        targetElementIndex,
        elementValue,
        targetIndex: bit === undefined ? targetIndex : undefined,
        targetRange: bit === undefined ? assignment.targetRange : [bit, bit],
        hasUnresolvedOperands:
          assignment.hasUnresolvedOperands ||
          (assignment.targetIndex !== undefined && targetIndex === undefined) ||
          (assignment.value !== undefined && value === undefined),
        unresolvedControlOnly:
          value || elementValue ? assignment.unresolvedControlOnly : undefined,
        hierarchicalTargets: assignment.hierarchicalTargets?.flatMap(
          (target) => {
            const signal = ids.get(target.signal);
            return signal === undefined
              ? []
              : [
                  {
                    ...target,
                    signal,
                    interfaceIndex:
                      target.interfaceIndex &&
                      remapValue(target.interfaceIndex, ids),
                  },
                ];
          },
        ),
      });
    }
    if (boundAssignments.length === generatedOwners.length)
      assignments.push(...boundAssignments);
    else assignments.push(assignment);
  }
  const graph = { ...trace, assignments };
  if (trace.scope === "module")
    return { ...graph, signals: [...signals.values()] };
  const reachable = traceDistances(graph, direction);
  const retained = new Set(reachable.keys());
  const connected = assignments.filter((assignment) => {
    const inputs = assignment.inputs.map((input) => input.signal);
    if (
      !(direction === "drivers" ? assignment.targets : inputs).some((id) =>
        reachable.has(id),
      )
    )
      return false;
    for (const id of [...assignment.targets, ...inputs]) retained.add(id);
    return true;
  });
  return {
    ...graph,
    assignments: connected,
    signals: [...signals.values()].filter((signal) => retained.has(signal.id)),
    frontier: trace.frontier.flatMap((item) =>
      [item.signal, ...(copies.get(item.signal) ?? [])]
        .filter((signal) => reachable.has(signal))
        .map((signal) => ({ ...item, signal })),
    ),
  };
}

function remapWordRead(
  read: VideTrace["assignments"][number]["wordRead"],
  ids: Pick<ReadonlyMap<number, number>, "get">,
  scopedIds?: ReadonlyMap<number | string, number>,
  generateIndices?: ReadonlyMap<string, number>,
) {
  if (!read) return undefined;
  const signal = ids.get(read.signal);
  const index = remapValue(read.index, ids, scopedIds, generateIndices);
  if (signal !== undefined && index) return { signal, index };
}

function remapFieldRead(
  read: VideTrace["assignments"][number]["fieldRead"],
  ids: Pick<ReadonlyMap<number, number>, "get">,
) {
  if (!read) return undefined;
  const signal = ids.get(read.signal);
  if (signal !== undefined) return { ...read, signal };
}

function selectRootElement(trace: VideTrace, element: number): VideTrace {
  if (
    !trace.assignments.some(
      ({ targets, targetElementIndex }) =>
        targetElementIndex && targets.includes(trace.root),
    )
  )
    return trace;
  const assignments = trace.assignments.flatMap((assignment) => {
    if (
      !assignment.targets.includes(trace.root) ||
      !assignment.targetElementIndex
    )
      return [assignment];
    const selected = evaluateTraceValue(
      assignment.targetElementIndex,
      undefined,
      () => undefined,
    );
    const index = selected && traceInteger(selected.bits, selected.signed);
    if (index === undefined) return [assignment];
    if (index !== BigInt(element)) return [];
    return [{ ...assignment, value: assignment.elementValue }];
  });
  const graph = { ...trace, assignments };
  const reachable = traceDistances(graph, "drivers");
  const connected = assignments.filter(({ targets }) =>
    targets.some((id) => reachable.has(id)),
  );
  const retained = new Set(reachable.keys());
  for (const { targets } of connected)
    for (const target of targets) retained.add(target);
  return {
    ...graph,
    assignments: connected,
    signals: trace.signals.filter(({ id }) => retained.has(id)),
    frontier: trace.frontier.filter(({ signal }) => reachable.has(signal)),
  };
}

async function bindKdbGenerateScope(
  trace: VideTrace,
  instance: string,
  design: DesignSession,
  sourceUri: (file: string) => string,
): Promise<VideTrace> {
  if (design.kind !== "kdb") return trace;
  const ancestors: string[] = [instance];
  for (;;) {
    const scope = ancestors[ancestors.length - 1];
    const resolved = await design.resolve(scope).catch(() => undefined);
    if (resolved?.kind !== "npiGenScope") break;
    const parent = await design.parent(scope).catch(() => "");
    if (!parent || !scope.startsWith(parent + ".")) break;
    ancestors.push(parent);
  }
  if (ancestors.length === 1) return trace;
  const inherited = new Map<number, string>();
  for (const signal of trace.signals) {
    if (signal.instance || !signal.declaration) continue;
    for (const scope of ancestors) {
      const record = await design
        .resolve(scope + "." + signal.name)
        .catch(() => undefined);
      if (
        record?.instance !== scope ||
        !record.file ||
        sourceUri(record.file) !== signal.declaration.uri ||
        record.line !== signal.declaration.range.start.line + 1
      )
        continue;
      if (scope !== instance) inherited.set(signal.id, scope);
      break;
    }
  }
  if (!inherited.size) return trace;
  return {
    ...trace,
    signals: trace.signals.map((signal) => {
      const owner = inherited.get(signal.id);
      return owner ? { ...signal, instance: owner } : signal;
    }),
    // Query assignments for inherited targets from their owning scope.
    assignments: trace.assignments.filter((assignment) =>
      assignment.targets.some((signal) => !inherited.has(signal)),
    ),
  };
}
async function resolveInterfacePaths(
  trace: VideTrace,
  instance: string,
  design: DesignSession,
  sourceUri: (file: string) => string,
): Promise<VideTrace> {
  const declarations = new Map(
    trace.signals.map((signal) => [signal.id, { ...signal }]),
  );
  const resolvedParameters = new Map<
    string,
    ReturnType<typeof lookupParameter>
  >();

  async function lookupParameter(id: number, owner: string) {
    const signal = declarations.get(id);
    if (!signal?.declaration) return;
    for (let scope = signal.instance ?? owner; scope; ) {
      const record = await design
        .resolve(scope + "." + signal.name)
        .catch(() => undefined);
      if (record) {
        if (
          record.kind === "npiParameter" &&
          record.instance === scope &&
          record.parameterValue &&
          sourceUri(record.file) === signal.declaration.uri &&
          record.line === signal.declaration.range.start.line + 1
        )
          return record.parameterValue;
        return;
      }
      if (signal.instance) return;
      const node = await design.resolve(scope).catch(() => undefined);
      if (node?.kind !== "npiGenScope") return;
      scope = await design.parent(scope).catch(() => "");
    }
  }

  function parameter(id: number, owner: string) {
    const key = JSON.stringify([id, owner]);
    let pending = resolvedParameters.get(key);
    if (!pending) {
      pending = lookupParameter(id, owner);
      resolvedParameters.set(key, pending);
    }
    return pending;
  }

  async function resolveBoundSelection(
    value: AssignmentValue | undefined,
    owner: string,
  ): Promise<AssignmentValue | undefined> {
    if (value?.op !== "boundSelect") return value;
    const [signal, left, right] = value.args;
    const ids = new Set<number>();
    for (const bound of [left, right])
      remapValue(bound, {
        get(id) {
          ids.add(id);
          return id;
        },
      });
    const values = new Map(
      await Promise.all(
        [...ids].map(async (id) => [id, await parameter(id, owner)] as const),
      ),
    );
    const bounds = [left, right].map((bound) => {
      const result = evaluateTraceValue(bound, undefined, (id) => {
        const parameter = values.get(id);
        return parameter && { ...parameter, width: parameter.bits.length };
      });
      return result && traceInteger(result.bits, result.signed);
    });
    const [first, last] = bounds;
    if (
      first === undefined ||
      last === undefined ||
      first < -0x80000000n ||
      first > 0x7fffffffn ||
      last < -0x80000000n ||
      last > 0x7fffffffn ||
      Math.abs(Number(first - last)) >= 4096
    )
      return value;
    for (const [id, parameter] of values)
      if (parameter) declarations.get(id)!.parameterValue = parameter;
    return { op: "select", args: [signal, Number(first), Number(last)] };
  }

  async function resolve<
    T extends { interfacePath?: string; interfaceIndex?: AssignmentValue },
  >(
    operand: T,
    owner: string,
    indices: ReadonlyMap<string, number>,
  ): Promise<T> {
    if (!operand.interfacePath || !operand.interfaceIndex) return operand;
    const parameters = new Set<number>();
    const specialized = remapValue(
      operand.interfaceIndex,
      {
        get(id: number) {
          parameters.add(id);
          return id;
        },
      },
      undefined,
      indices,
    );
    const values = new Map<
      number,
      NonNullable<VideTrace["signals"][number]["parameterValue"]>
    >();
    for (const id of parameters) {
      const value = await parameter(id, owner);
      if (!value) return operand;
      values.set(id, value);
    }
    const value =
      specialized &&
      evaluateTraceValue(specialized, undefined, (id) => {
        const parameter = values.get(id);
        return parameter && { ...parameter, width: parameter.bits.length };
      });
    const index = value && traceInteger(value.bits, value.signed);
    if (index === undefined || index < -0x80000000n || index > 0x7fffffffn)
      return operand;
    for (const [id, parameter] of values)
      declarations.get(id)!.parameterValue = parameter;
    const dot = operand.interfacePath.indexOf(".");
    return {
      ...operand,
      interfacePath:
        operand.interfacePath.slice(0, dot) +
        "[" +
        index +
        "]" +
        operand.interfacePath.slice(dot),
      interfaceIndex: undefined,
    };
  }
  const assignments = await Promise.all(
    trace.assignments.map(async (assignment) => {
      if (
        !assignment.inputs.some((input) => input.interfaceIndex) &&
        !assignment.hierarchicalTargets?.some(
          (target) => target.interfaceIndex,
        ) &&
        assignment.value?.op !== "boundSelect" &&
        assignment.wordRead?.index.op !== "boundSelect" &&
        assignment.targetElementIndex?.op !== "boundSelect"
      )
        return assignment;
      const owner = assignment.instance ?? instance;
      const indices = new Map(Object.entries(assignment.generateIndices ?? {}));
      const word = assignment.wordRead;
      return {
        ...assignment,
        value: await resolveBoundSelection(assignment.value, owner),
        wordRead: word && {
          ...word,
          index: (await resolveBoundSelection(word.index, owner))!,
        },
        targetElementIndex: await resolveBoundSelection(
          assignment.targetElementIndex,
          owner,
        ),
        inputs: await Promise.all(
          assignment.inputs.map((input) => resolve(input, owner, indices)),
        ),
        hierarchicalTargets:
          assignment.hierarchicalTargets &&
          (await Promise.all(
            assignment.hierarchicalTargets.map((target) =>
              resolve(target, owner, indices),
            ),
          )),
      };
    }),
  );
  return { ...trace, assignments, signals: [...declarations.values()] };
}

function selectInterfaceAssignments(
  trace: VideTrace,
  direction: TraceDirection,
  path: string,
): VideTrace {
  const assignments = trace.assignments.filter((assignment) => {
    const operands =
      direction === "drivers"
        ? assignment.hierarchicalTargets
        : assignment.inputs;
    const aliases = operands?.filter(
      (operand) => operand.signal === trace.root && operand.interfacePath,
    );
    return (
      !aliases?.length ||
      aliases.some(
        (operand) => operand.interfaceIndex || operand.interfacePath === path,
      )
    );
  });
  const graph = { ...trace, assignments };
  const reachable = traceDistances(graph, direction);
  return {
    ...graph,
    assignments: assignments.filter((assignment) =>
      (direction === "drivers"
        ? assignment.targets
        : assignment.inputs.map(({ signal }) => signal)
      ).some((signal) => reachable.has(signal)),
    ),
  };
}

type OperandBinding = Pick<
  DesignHierarchicalAccess,
  "line" | "column" | "signal" | "instance" | "write"
> & {
  uri: string;
  owner: string;
  component?: number;
  shape?: { width: number; twoState: boolean };
};

async function interfaceBindings(
  trace: VideTrace,
  owner: string,
  design: DesignSession,
  sourceUri: (file: string) => string,
): Promise<OperandBinding[]> {
  if (!design.interfaceMember && !design.interfaceMembers) return [];
  const declarations = new Map(
    trace.signals.map((signal) => [signal.id, signal]),
  );
  const references: OperandBinding[] = [];
  for (const assignment of trace.assignments) {
    for (const [write, operands] of [
      [false, assignment.inputs],
      [true, assignment.hierarchicalTargets ?? []],
    ] as const) {
      for (const operand of operands) {
        if (!operand.interfacePath || operand.interfaceIndex) continue;
        const signal = declarations.get(operand.signal);
        const scope = assignment.instance ?? owner;
        const part = operand.interfaceComponent;
        const members =
          part &&
          (await design
            .interfaceMembers?.(scope, operand.interfacePath)
            .catch(() => undefined));
        const member = part
          ? members?.length === part[1]
            ? members[part[0]]
            : undefined
          : await design
              .interfaceMember?.(scope, operand.interfacePath)
              .catch(() => undefined);
        if (
          !signal?.declaration ||
          !member?.file ||
          !member.instance ||
          (part &&
            (!Number.isInteger(member.interfaceWidth) ||
              member.interfaceWidth! < 1 ||
              member.interfaceTwoState === undefined)) ||
          member.interfaceRange?.[0] !== operand.interfaceRange?.[0] ||
          member.interfaceRange?.[1] !== operand.interfaceRange?.[1] ||
          member.fullname !== member.instance + "." + signal.name ||
          sourceUri(member.file) !== signal.declaration.uri ||
          member.line !== signal.declaration.range.start.line + 1
        )
          continue;
        const {
          uri,
          range: { start },
        } = operand.location;
        references.push({
          owner: assignment.instance ?? owner,
          uri,
          line: start.line + 1,
          column: (operand.byteColumn ?? start.character) + 1,
          instance: member.instance,
          signal: signal.name,
          write,
          component: part?.[0],
          shape: part && {
            width: member.interfaceWidth!,
            twoState: member.interfaceTwoState!,
          },
        });
      }
    }
  }
  return references;
}

async function hierarchicalLoad(
  trace: VideTrace,
  instance: string,
  read: DesignHierarchicalAccess,
  declaration: VideTrace["signals"][number]["declaration"],
  design: DesignSession,
  sourceUri: (file: string) => string,
): Promise<VideTrace | undefined> {
  const active = await applyGenerateBranches(
    trace,
    instance,
    design,
    "drivers",
    sourceUri,
  );
  const drivers = bindHierarchicalOperands(active, instance, design, sourceUri);
  const source = drivers.signals.find(
    (signal) =>
      signal.instance === read.instance &&
      signal.name === read.signal &&
      JSON.stringify(signal.declaration) === JSON.stringify(declaration),
  );
  if (!source) return;
  const uri = sourceUri(read.file);
  const assignments = drivers.assignments.filter((assignment) =>
    assignment.inputs.some(
      (input) =>
        input.signal === source.id &&
        input.hierarchical &&
        input.location.uri === uri &&
        input.location.range.start.line === read.line - 1 &&
        (input.byteColumn ?? input.location.range.start.character) ===
          read.column - 1,
    ),
  );
  if (!assignments.length) return;
  const retained = new Set(
    assignments.flatMap(({ targets, inputs }) => [
      ...targets,
      ...inputs.map(({ signal }) => signal),
    ]),
  );
  return {
    ...drivers,
    root: source.id,
    signals: drivers.signals.filter(({ id }) => retained.has(id)),
    assignments,
    frontier: drivers.frontier.filter(({ signal }) => retained.has(signal)),
  };
}

function bindHierarchicalOperands(
  trace: VideTrace,
  instance: string,
  design: DesignSession,
  sourceUri: (file: string) => string,
  targetRoot?: Port,
  interfaceReferences: readonly OperandBinding[] = [],
): VideTrace {
  if (
    !trace.assignments.some(
      (assignment) =>
        assignment.hierarchicalTargets?.length ||
        assignment.inputs.some((input) => input.hierarchical),
    )
  )
    return trace;
  const site = (
    owner: string,
    uri: string,
    line: number,
    column: number,
    signal: string,
    write: boolean,
    component?: number,
  ) => JSON.stringify([owner, uri, line, column, signal, write, component]);
  const references = new Map<
    string,
    Pick<OperandBinding, "instance" | "shape"> | null
  >();
  const elaboratedReferences = design.hierarchicalAccesses?.(instance) ?? [];
  for (const read of [
    ...elaboratedReferences.map((read) => ({
      ...read,
      owner: instance,
      uri: sourceUri(read.file),
    })),
    ...interfaceReferences,
  ]) {
    const location = site(
      read.owner,
      read.uri,
      read.line - 1,
      read.column - 1,
      read.signal,
      read.write,
      "component" in read ? read.component : undefined,
    );
    const previous = references.get(location);
    const shape = "shape" in read ? read.shape : undefined;
    references.set(
      location,
      previous === undefined ||
        (previous?.instance === read.instance &&
          previous.shape?.width === shape?.width &&
          previous.shape?.twoState === shape?.twoState)
        ? { instance: read.instance, shape }
        : null,
    );
  }
  const signals = new Map(trace.signals.map((signal) => [signal.id, signal]));
  const localIds = new Map(trace.signals.map(({ id }) => [id, id]));
  const frontier = trace.frontier.map((item) => ({ ...item }));
  const scoped = new Map<string, number>();
  let next = Math.max(...signals.keys()) + 1;
  const bind = (
    operand: {
      signal: number;
      location: VideTrace["assignments"][number]["location"];
      byteColumn?: number;
      interfaceComponent?: [number, number];
    },
    write: boolean,
    owner: string,
  ) => {
    const signal = signals.get(operand.signal);
    if (!signal) return undefined;
    const { line, character } = operand.location.range.start;
    const member = references.get(
      site(
        owner,
        operand.location.uri,
        line,
        operand.byteColumn ?? character,
        signal.name,
        write,
        operand.interfaceComponent?.[0],
      ),
    );
    if (!member) return undefined;
    const scope = member.instance;
    const identity = JSON.stringify([signal.id, scope]);
    const id = scoped.get(identity) ?? next++;
    scoped.set(identity, id);
    signals.set(id, { ...signal, id, instance: scope });
    return { id, shape: member.shape };
  };
  const assignments = trace.assignments.flatMap((assignment) => {
    const owner = assignment.instance ?? instance;
    const scopedIds = new Map<number | string, number>();
    let unresolved = false;
    const inputs = assignment.inputs.flatMap((input) => {
      if (!input.hierarchical) return [input];
      const member = bind(input, false, owner);
      if (!member) {
        unresolved = true;
        return [];
      }
      if (input.sourceOffset !== undefined) {
        const part = input.interfaceComponent;
        scopedIds.set(
          part ? componentKey(input.sourceOffset, part[0]) : input.sourceOffset,
          member.id,
        );
      }
      return [{ ...input, signal: member.id }];
    });
    const originalTargets = new Set(
      assignment.hierarchicalTargets?.map(({ signal }) => signal),
    );
    const shapes = new Map<number, NonNullable<OperandBinding["shape"]>>();
    const hierarchicalTargets = assignment.hierarchicalTargets?.flatMap(
      (target) => {
        const member = bind(target, true, owner);
        if (member) {
          if (target.interfaceComponent && member.shape)
            shapes.set(target.interfaceComponent[0], member.shape);
          return [{ ...target, signal: member.id }];
        }
        for (const input of inputs)
          frontier.push({
            signal: input.signal,
            reason: "unresolvedHierarchicalWrite",
          });
        return [];
      },
    );
    const targets = [
      ...assignment.targets.filter((target) => !originalTargets.has(target)),
      ...(hierarchicalTargets?.map(({ signal }) => signal) ?? []),
    ];
    if (unresolved) {
      for (const signal of targets)
        frontier.push({ signal, reason: "unresolvedHierarchicalRead" });
    }
    const bound: VideTrace["assignments"][number] = {
      ...assignment,
      inputs,
      targets,
      hierarchicalTargets,
      hasUnresolvedOperands: unresolved || assignment.hasUnresolvedOperands,
      unresolvedControlOnly: unresolved
        ? undefined
        : assignment.unresolvedControlOnly,
      value:
        !unresolved && assignment.value
          ? remapValue(assignment.value, localIds, scopedIds)
          : undefined,
      wordRead: unresolved
        ? undefined
        : remapWordRead(assignment.wordRead, localIds, scopedIds),
      fieldRead: unresolved
        ? undefined
        : remapFieldRead(assignment.fieldRead, localIds),
      targetField: unresolved
        ? undefined
        : remapFieldRead(assignment.targetField, localIds),
      fieldValue:
        !unresolved && assignment.fieldValue
          ? remapValue(assignment.fieldValue, localIds, scopedIds)
          : undefined,
      targetIndex:
        !unresolved && assignment.targetIndex
          ? remapValue(assignment.targetIndex, localIds, scopedIds)
          : undefined,
      guards: assignment.guards?.map((guard) => ({
        ...guard,
        expression: unresolved
          ? null
          : guard.expression && remap(guard.expression, localIds, scopedIds),
      })),
    };
    if (
      assignment.hierarchicalTargets?.some(
        (target) => target.interfaceComponent,
      )
    )
      return splitCompoundWrite(bound, shapes, frontier);
    return [bound];
  });
  const scopedRoot =
    targetRoot && signals.get(trace.root)?.name === targetRoot.signal
      ? scoped.get(JSON.stringify([trace.root, targetRoot.instance]))
      : undefined;
  const root = scopedRoot ?? trace.root;
  const retained = new Set([root]);
  for (const { targets, inputs } of assignments) {
    for (const id of targets) retained.add(id);
    for (const { signal } of inputs) retained.add(signal);
  }
  for (const item of frontier)
    if (!retained.has(item.signal)) item.signal = root;
  return {
    ...trace,
    root,
    signals: [...signals.values()].filter(({ id }) => retained.has(id)),
    assignments: assignments.filter((assignment) => assignment.targets.length),
    frontier,
  };
}

function splitCompoundWrite(
  assignment: VideTrace["assignments"][number],
  shapes: ReadonlyMap<number, NonNullable<OperandBinding["shape"]>>,
  frontier: VideTrace["frontier"],
): VideTrace["assignments"] {
  const parts = assignment.hierarchicalTargets ?? [];
  const size = [...shapes.values()].reduce(
    (total, { width }) => total + width,
    0,
  );
  const complete =
    parts.length >= 2 &&
    parts.length === shapes.size &&
    parts.every(
      (target, index) =>
        target.interfaceComponent?.[0] === index &&
        target.interfaceComponent[1] === parts.length,
    );
  if (!complete || size > 4096) {
    for (const signal of assignment.targets)
      frontier.push({ signal, reason: "unresolvedHierarchicalWrite" });
    return [
      {
        ...assignment,
        hasUnresolvedOperands: true,
        unresolvedControlOnly: undefined,
        value: undefined,
      },
    ];
  }
  const packed: AssignmentValue | undefined = assignment.value && {
    op: "cast",
    args: [size, false, false, assignment.value],
  };
  let end = size;
  return parts.map((part, index) => {
    const { width, twoState } = shapes.get(index)!;
    const left = end - 1;
    end -= width;
    const slice: AssignmentValue | undefined = packed && {
      op: "slice",
      args: [packed, left, end],
    };
    const range = part.interfaceRange;
    const overlaps = parts.some((other, otherIndex) => {
      if (otherIndex === index || part.signal !== other.signal) return false;
      const otherRange = other.interfaceRange;
      return (
        !range ||
        !otherRange ||
        (Math.min(...range) <= Math.max(...otherRange) &&
          Math.min(...otherRange) <= Math.max(...range))
      );
    });
    return {
      ...assignment,
      targets: [part.signal],
      hierarchicalTargets: [part],
      targetRange: range,
      overlappingModportWrite: overlaps ? true : undefined,
      value:
        slice && twoState
          ? { op: "cast", args: [width, false, true, slice] }
          : slice,
    };
  });
}

export async function bindModuleGenerateBranches(
  trace: VideTrace,
  instance: string,
  design: DesignSession,
  sourceUri: (file: string) => string,
) {
  const bound = await bindKdbGenerateAssignments(
    trace,
    instance,
    design,
    "drivers",
    sourceUri,
  );
  return applyGenerateBranches(bound, instance, design, "drivers", sourceUri);
}

async function applyGenerateBranches(
  trace: VideTrace,
  instance: string,
  design: DesignSession,
  direction: TraceDirection,
  sourceUri: (file: string) => string,
): Promise<VideTrace> {
  if (!trace.assignments.some((item) => item.generateBranches?.length))
    return trace;
  const labelKey = ({ uri, name, line, byteColumn }: GenerateLabel) =>
    JSON.stringify([uri, name, line, byteColumn]);
  const elaborated = new Set(
    design.generateLabels?.(instance).map(({ file, name, line, column }) =>
      labelKey({
        uri: sourceUri(file),
        name,
        line: line - 1,
        byteColumn: column - 1,
      }),
    ),
  );
  const uncertain = new Set<VideTrace["assignments"][number]>();
  const assignments: VideTrace["assignments"] = [];
  const kdbLabels = new Map<string, Promise<boolean>>();
  function selectedInDesign(label: GenerateLabel, scope: string) {
    if (design.kind !== "kdb") return elaborated.has(labelKey(label));
    const fullname = scope + "." + label.name;
    const key = JSON.stringify([fullname, labelKey(label)]);
    let resolved = kdbLabels.get(key);
    if (!resolved) {
      resolved = design.resolve(fullname).then(
        (object) =>
          object?.kind === "npiGenScope" &&
          object.fullname === fullname &&
          object.line === label.line + 1 &&
          !!object.file &&
          sourceUri(object.file) === label.uri,
        () => false,
      );
      kdbLabels.set(key, resolved);
    }
    return resolved;
  }
  for (const assignment of trace.assignments) {
    let scope = instance;
    let resolved = true;
    let excluded = false;
    for (const branch of assignment.generateBranches ?? []) {
      if (branch.loopScope) {
        resolved = false;
        break;
      }
      const selected =
        branch.selected && (await selectedInDesign(branch.selected, scope));
      let alternative = false;
      for (const site of branch.alternatives)
        if (await selectedInDesign(site, scope)) {
          alternative = true;
          break;
        }
      // Absence alone gives no proof. An elaborated sibling proves exclusion
      // only when the assignment has its own identifiable source label.
      if (branch.selected && !selected && alternative) {
        excluded = true;
        break;
      }
      if (!selected || alternative) resolved = false;
      if (design.kind === "kdb") {
        if (!resolved) break;
        scope += "." + branch.selected!.name;
      }
    }
    if (excluded) continue;
    if (!resolved) uncertain.add(assignment);
    if (trace.scope === "module") {
      if (resolved)
        assignments.push({
          ...assignment,
          instance: assignment.instance ?? scope,
        });
    } else {
      assignments.push(assignment);
    }
  }
  if (trace.scope === "module")
    return {
      ...trace,
      assignments,
      diagnostics: uncertain.size
        ? [...(trace.diagnostics ?? []), "unresolvedGenerateBranch"]
        : trace.diagnostics,
    };
  if (assignments.length === trace.assignments.length && !uncertain.size)
    return trace;
  const distances = traceDistances({ ...trace, assignments }, direction);
  const retainedSignals = new Set(distances.keys());
  const frontier = trace.frontier.filter((item) => distances.has(item.signal));
  const connected = assignments.flatMap((assignment) => {
    const inputs = assignment.inputs.map(({ signal }) => signal);
    const starts = direction === "drivers" ? assignment.targets : inputs;
    const reachable = starts.find((id) => distances.has(id));
    if (reachable === undefined) return [];
    for (const id of [...assignment.targets, ...inputs])
      retainedSignals.add(id);
    if (uncertain.has(assignment)) {
      frontier.push({ signal: reachable, reason: "unresolvedGenerateBranch" });
      return [
        {
          ...assignment,
          hasUnresolvedOperands: true,
          unresolvedControlOnly: undefined,
        },
      ];
    }
    return [assignment];
  });
  return {
    ...trace,
    signals: trace.signals.filter(({ id }) => retainedSignals.has(id)),
    assignments: connected,
    frontier,
  };
}

function traceDistances(trace: VideTrace, direction: TraceDirection) {
  const edges = new Map<number, Set<number>>();
  for (const assignment of trace.assignments) {
    const inputs = assignment.inputs.map(({ signal }) => signal);
    const [starts, ends] =
      direction === "drivers"
        ? [assignment.targets, inputs]
        : [inputs, assignment.targets];
    for (const start of starts) {
      const neighbors = edges.get(start) ?? new Set<number>();
      for (const end of ends) neighbors.add(end);
      edges.set(start, neighbors);
    }
  }
  const distances = new Map([[trace.root, 0]]);
  for (const [signal, distance] of distances) {
    for (const next of edges.get(signal) ?? []) {
      if (!distances.has(next)) distances.set(next, distance + 1);
    }
  }
  return distances;
}
