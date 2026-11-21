// SPDX-License-Identifier: MPL-2.0

import { english } from "./localization-en";

const browser = globalThis as {
  document?: { documentElement: { lang: string } };
};
let language = browser.document?.documentElement.lang || "zh-cn";

export function configureLanguage(locale?: string) {
  if (locale) language = locale;
}

function chinese(locale: string) {
  return /^zh(?:-|$)/i.test(locale);
}

export function localize(message: string, ...args: (string | number)[]) {
  return (chinese(language) ? message : (english[message] ?? message)).replace(
    /\{(\d+)\}/g,
    (token, index) => (args[index] === undefined ? token : String(args[index])),
  );
}

const htmlEscapes: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};
function translateMarkup(text: string) {
  const translation = english[text.trim()];
  return translation === undefined
    ? text
    : text.replace(text.trim(), () =>
        translation.replace(/[&<>"']/g, (character) => htmlEscapes[character]),
      );
}

export function localizeHtml(html: string) {
  if (chinese(language)) return html;
  return html
    .replace(/(<html\s+lang=")zh-CN(")/i, "$1en$2")
    .replace(
      /(>)([^<>]*[\u3400-\u9fff][^<>]*)(<)/g,
      (_, before, text, after) => before + translateMarkup(text) + after,
    )
    .replace(
      /(\s(?:aria-label|title|placeholder)=")([^"]+)(")/g,
      (_, before, text, after) => before + translateMarkup(text) + after,
    );
}
