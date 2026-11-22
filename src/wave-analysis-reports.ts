// SPDX-License-Identifier: MPL-2.0
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { observationReport, selectionText, type VideTrace } from "./rtl-trace";
import {
  executionAssignmentReport,
  executionMermaidPages,
  executionEventLines,
  executionTransitionReport,
  readExecutionEvidence,
} from "./rtl-execution";
import { mermaidMarkdown } from "./trace-mermaid";

import type { ObservedContext } from "./wave-analysis-observations";
import type { LiveContext } from "./wave-analysis-context";

export function traceExecutionComparisonReport(
  evidence:
    | Pick<
        ObservedContext,
        "executionAssignments" | "executionTransitions" | "upstreamExecution"
      >
    | undefined,
  events: Awaited<ReturnType<typeof readExecutionEvidence>>["events"] = [],
) {
  const { executionAssignments, executionTransitions, upstreamExecution } =
    evidence ?? {};
  let report = "";
  if (executionAssignments?.length)
    report += executionAssignmentReport(executionAssignments);
  if (executionTransitions?.length)
    report += executionTransitionReport(executionTransitions);
  for (const { transitions, instance, signal, bit } of upstreamExecution ?? [])
    report += executionTransitionReport(
      transitions,
      instance + "." + signal + selectionText(undefined, bit),
    );
  const upstreamWrites = mergeExecutionEvents(
    [],
    (upstreamExecution ?? []).map(({ writeEvents }) => writeEvents ?? []),
  );
  if (upstreamWrites.length)
    report +=
      "\n## Upstream write events\n\n" +
      executionEventLines(upstreamWrites).join("\n") +
      "\n";
  if (
    upstreamExecution?.some(
      ({ callbackEvents, statementEvents, writeEvents }) =>
        callbackEvents?.length ||
        statementEvents?.length ||
        writeEvents?.length,
    )
  )
    report +=
      "\n## Root and upstream execution order\n\n" +
      mermaidMarkdown(traceExecutionGraph(events, upstreamExecution)) +
      "\n";
  return report;
}
function mergeExecutionEvents(
  selected: Awaited<ReturnType<typeof readExecutionEvidence>>["events"],
  upstream: readonly (typeof selected)[],
) {
  const events = new Map(selected.map((event) => [event.ordinal, event]));
  for (const group of upstream)
    for (const event of group)
      if (!events.has(event.ordinal)) events.set(event.ordinal, event);
  return [...events.values()].sort(
    (left, right) => left.ordinal - right.ordinal,
  );
}
export function traceExecutionGraph(
  selected: Awaited<ReturnType<typeof readExecutionEvidence>>["events"],
  upstream: ObservedContext["upstreamExecution"],
) {
  const groups = (upstream ?? []).flatMap(
    ({ callbackEvents, statementEvents, writeEvents }) => [
      callbackEvents ?? [],
      statementEvents ?? [],
      writeEvents ?? [],
    ],
  );
  return executionMermaidPages({
    events: mergeExecutionEvents(selected, groups),
  });
}

export function liveTraceReport(evidence: LiveContext, trace: VideTrace) {
  const { context, replayMatch, executionCoverage, execution } = evidence;
  const report = [
    observationReport(context, trace),
    ...(replayMatch
      ? [
          "## Live event replay verification",
          "",
          "- Selected signal · " + replayMatch.status,
          ...replayMatch.upstream.map(
            ({ instance, signal, status }) =>
              "- " + instance + "." + signal + " · " + status,
          ),
          "",
        ]
      : []),
    traceExecutionComparisonReport(evidence, execution),
    "## Live execution coverage",
    "",
    "- Live session · " + context.provider.liveSessionId,
    executionCoverage.available
      ? "Recorded events available."
      : "The harness did not declare execution events.",
    "- Missing sequence numbers in the session · " +
      executionCoverage.missingOrdinals,
    "- Events omitted from this response · " +
      executionCoverage.responseOmitted,
    ...(executionCoverage.olderEventsDiscarded
      ? ["- The retained event buffer omits part of the requested window."]
      : []),
    "",
  ];
  if (execution.length)
    report.push(
      "## Live execution events",
      "",
      ...executionEventLines(execution),
      "",
    );
  return "\n" + report.join("\n");
}
