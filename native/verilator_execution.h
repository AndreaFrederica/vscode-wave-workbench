// SPDX-License-Identifier: MPL-2.0
#pragma once

#include <cstdint>

void wave_workbench_begin_slot(std::uint64_t tick);
void wave_workbench_external_step(const char *statement, const char *operation,
                                  const char *value = nullptr);
bool wave_workbench_observe_nba(const char *instance, const char *signal,
                                const char *value);
bool wave_workbench_nba_evaluation(const char *instance, const char *signal,
                                   const char *statement,
                                   std::uint64_t &ordinal);
bool wave_workbench_record_nba_commit(const char *instance, const char *signal,
                                      std::uint64_t evaluation,
                                      const char *value, bool end_of_slot);
bool wave_workbench_record_nba_superseded(const char *instance,
                                          const char *signal,
                                          std::uint64_t evaluation,
                                          std::uint64_t replacement);
std::uint64_t wave_workbench_stage_nba(const char *instance, const char *signal,
                                      const char *statement, std::uint64_t pending);
void wave_workbench_commit_nba(const char *instance, const char *signal,
                               std::uint64_t pending, std::uint64_t value,
                               unsigned width);
void wave_workbench_finish_execution(std::uint64_t tick);
