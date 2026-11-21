// SPDX-License-Identifier: MPL-2.0

import * as monaco from "monaco-editor/editor/editor.api.js";
import "monaco-editor/editor/contrib/suggest/browser/suggestController.js";
import "monaco-editor/editor/contrib/placeholderText/browser/placeholderText.contribution.js";
import "monaco-editor/editor/contrib/contextmenu/browser/contextmenu.js";
import "monaco-editor/editor/contrib/clipboard/browser/clipboard.js";
import { conf, language } from "monaco-editor/languages/definitions/tcl/tcl.js";
import { localize } from "../shared/localization";
import type {
  TclConsoleConfig,
  TclSignalSuggestions,
} from "../shared/tcl-console";

export { monaco };

const builtins = [
  "append",
  "array",
  "break",
  "catch",
  "concat",
  "continue",
  "dict",
  "error",
  "eval",
  "expr",
  "file",
  "for",
  "foreach",
  "format",
  "if",
  "incr",
  "info",
  "join",
  "lappend",
  "lindex",
  "list",
  "llength",
  "lrange",
  "lsearch",
  "lsort",
  "namespace",
  "proc",
  "puts",
  "regexp",
  "regsub",
  "return",
  "set",
  "source",
  "split",
  "string",
  "subst",
  "switch",
  "try",
  "unset",
  "uplevel",
  "while",
];

const signalOptions: Record<string, number> = {
  waveAnnotate: 0,
  waveDecode: 1,
  waveDecodeEvents: 0,
  waveFindSignals: 0,
  waveGetEvents: 0,
  waveMeasureAnalog: 0,
  wvAddSignal: Infinity,
  wvDeleteSignal: Infinity,
  wvGetSigValueByTime: 0,
  wvSelectSignal: 0,
  wvSetRadix: Infinity,
};

export function createTclEditor(container: HTMLElement) {
  let worker: Promise<string>;
  const workerUrl = document.body.dataset.worker!;
  (
    globalThis as unknown as {
      MonacoEnvironment: import("monaco-editor/editor/editor.api.js").Environment;
    }
  ).MonacoEnvironment = {
    getWorker: () => {
      worker ??= fetch(workerUrl)
        .then((response) => {
          if (!response.ok) throw Error(response.statusText);
          return response.blob();
        })
        .then((blob) =>
          URL.createObjectURL(new Blob([blob], { type: "text/javascript" })),
        );
      return worker.then((url) => new Worker(url, { name: "tcl-editor" }));
    },
  };

  monaco.languages.register({ id: "tcl" });
  monaco.languages.setMonarchTokensProvider("tcl", language);
  monaco.languages.setLanguageConfiguration("tcl", conf);
  const editor = monaco.editor.create(container, {
    language: "tcl",
    ariaLabel: localize("Tcl 命令"),
    placeholder: localize("输入 Tcl 命令"),
    readOnly: true,
    automaticLayout: true,
    lineNumbers: "off",
    glyphMargin: false,
    folding: false,
    lineDecorationsWidth: 0,
    lineNumbersMinChars: 0,
    renderLineHighlight: "none",
    autoClosingBrackets: "never",
    autoClosingQuotes: "never",
    selectionHighlight: false,
    occurrencesHighlight: "off",
    quickSuggestions: { other: "on", strings: "on", comments: "off" },
    quickSuggestionsDelay: 180,
    suggestSelection: "first",
    acceptSuggestionOnEnter: "on",
    wordBasedSuggestions: "off",
    scrollBeyondLastLine: false,
    wordWrap: "on",
    minimap: { enabled: false },
    scrollbar: {
      horizontal: "hidden",
      verticalScrollbarSize: 6,
      alwaysConsumeMouseWheel: false,
    },
    overviewRulerLanes: 0,
  });

  let composing = false;
  editor.onDidCompositionStart(() => {
    composing = true;
  });
  editor.onDidCompositionEnd(() => {
    composing = false;
  });
  container.addEventListener(
    "keydown",
    (event) => {
      if (event.key !== "Enter") return;
      const imeKey = event.isComposing || event.keyCode === 229;
      if (!imeKey && !composing) return;
      event.stopImmediatePropagation();
      if (!imeKey) event.preventDefault();
    },
    true,
  );

  function resize() {
    const height = Math.min(
      editor.getContentHeight(),
      Math.max(24, window.innerHeight * 0.4),
    );
    container.style.height = Math.ceil(height) + "px";
  }

  function applyStyle(config?: TclConsoleConfig) {
    const style = getComputedStyle(document.body);
    const themeColor = (key: string) =>
      style.getPropertyValue("--vscode-" + key.replaceAll(".", "-")).trim();
    const classes = document.body.classList;
    const base = classes.contains("vscode-high-contrast-light")
      ? "hc-light"
      : classes.contains("vscode-high-contrast")
        ? "hc-black"
        : classes.contains("vscode-light")
          ? "vs"
          : "vs-dark";
    const colors: Record<string, string> = {};
    for (const key of [
      "editor.foreground",
      "editorCursor.foreground",
      "editor.selectionBackground",
      "editorSuggestWidget.background",
      "editorSuggestWidget.foreground",
      "editorSuggestWidget.border",
      "editorSuggestWidget.selectedBackground",
      "editorSuggestWidget.selectedForeground",
      "editorSuggestWidget.highlightForeground",
    ]) {
      const color = themeColor(key);
      if (color) colors[key] = color;
    }
    const background =
      themeColor("panel.background") || themeColor("editor.background");
    if (background) colors["editor.background"] = background;
    monaco.editor.defineTheme("wave-tcl", {
      base,
      inherit: true,
      rules: [],
      colors,
    });
    monaco.editor.setTheme("wave-tcl");

    const fontFamily =
      config?.fontFamily || themeColor("editor-font-family") || "monospace";
    const fontSize =
      config?.fontSize || parseFloat(themeColor("editor-font-size")) || 13;
    const lineHeight = config?.lineHeight || Math.round(fontSize * 1.4);
    editor.updateOptions({ fontFamily, fontSize, lineHeight });
    document.body.style.setProperty("--console-font-family", fontFamily);
    document.body.style.setProperty("--console-font-size", `${fontSize}px`);
    document.body.style.setProperty("--console-line-height", `${lineHeight}px`);
    resize();
  }

  editor.onDidContentSizeChange(resize);
  window.addEventListener("resize", resize);
  return { editor, applyStyle };
}

type SignalLookup = (
  prefix: string,
  token: import("monaco-editor/editor/editor.api.js").CancellationToken,
) => Promise<TclSignalSuggestions["signals"]>;

export function registerTclCompletions(
  getConfig: () => TclConsoleConfig | undefined,
  lookup: SignalLookup,
) {
  const kinds = monaco.languages.CompletionItemKind;
  monaco.languages.registerCompletionItemProvider("tcl", {
    triggerCharacters: ["-", "/", ".", " "],
    async provideCompletionItems(model, position, _context, token) {
      const input = model
        .getLineContent(position.lineNumber)
        .slice(0, position.column - 1);
      const commandLine = input.split(";").at(-1)!.trimStart();
      if (commandLine.startsWith("#")) return { suggestions: [] };
      const args = commandLine.split(/\s+/);
      const command = args.shift()!;
      const prefix = args.pop() ?? command;
      const range = new monaco.Range(
        position.lineNumber,
        position.column - prefix.length,
        position.lineNumber,
        position.column,
      );
      const config = getConfig();
      function suggestions(labels: string[], kind: number) {
        return labels
          .filter((label) =>
            label.toLowerCase().startsWith(prefix.toLowerCase()),
          )
          .map((label) => ({ label, insertText: label, kind, range }));
      }
      if (command === prefix && !/\s/.test(commandLine)) {
        return {
          suggestions: suggestions(
            [...builtins, ...(config?.commands ?? [])],
            kinds.Function,
          ),
        };
      }
      const options = config?.options[command];
      const flags = [
        ...Object.keys(options ?? {}),
        ...(command.startsWith("wv") && command !== "wvCreateWindow"
          ? ["-win"]
          : []),
      ];
      if (prefix.startsWith("-") && !/^-[\d.]/.test(prefix)) {
        return { suggestions: suggestions(flags, kinds.Keyword) };
      }
      const option = args.at(-1);
      const formats =
        command === "wvSetRadix"
          ? ["Bin", "Oct", "Hex", "Dec"]
          : ["Bin", "Oct", "Hex", "UDec", "2Com"];
      if (option === "-format" && options?.[option])
        return { suggestions: suggestions(formats, kinds.EnumMember) };
      if (command === "waveTool" && args.length === 0)
        return {
          suggestions: suggestions(config?.tools ?? [], kinds.Function),
        };
      if (command === "waveDecode" && args.length === 0)
        return {
          suggestions: suggestions(["list", "set", "clear"], kinds.Keyword),
        };

      let positional = 0;
      for (let i = 0; i < args.length; i++) {
        if (flags.includes(args[i])) i += options?.[args[i]] ?? 1;
        else positional++;
      }
      const query = prefix.replace(/^["{]/, "");
      const wantsSignal =
        (option === "-signal" && options?.[option]) ||
        (!flags.includes(option ?? "") &&
          positional <= signalOptions[command] &&
          (command !== "waveDecode" || positional === 1));
      if (
        !wantsSignal ||
        query.length < 2 ||
        query.length > 256 ||
        /[\s";{}$]/.test(query)
      )
        return { suggestions: [] };
      const signals = await lookup(query, token);
      return {
        suggestions: signals.map((signal) => ({
          ...signal,
          filterText: signal.label.toLowerCase().startsWith(query.toLowerCase())
            ? signal.label
            : prefix,
          kind: kinds.Variable,
          range,
        })),
      };
    },
  });
}
