// SPDX-License-Identifier: MPL-2.0

export const coralBridgeId = "coralnpu.axi-tluh";
export function isAxiDecoder(id: string) {
  return id === "amba.axi4" || id === coralBridgeId;
}
