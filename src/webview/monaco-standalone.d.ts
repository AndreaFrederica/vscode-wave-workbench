// SPDX-License-Identifier: MPL-2.0

declare module "monaco-editor/editor/editor.api.js" {
  export * from "monaco-editor/esm/vs/editor/editor.api";
}

declare module "monaco-editor/languages/definitions/tcl/tcl.js" {
  import type { languages } from "monaco-editor/esm/vs/editor/editor.api";
  export const conf: languages.LanguageConfiguration;
  export const language: languages.IMonarchLanguage;
}
