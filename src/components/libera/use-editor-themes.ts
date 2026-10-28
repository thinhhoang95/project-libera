"use client";

import { createContext, useContext, useEffect, useState } from "react";
import { EDITOR_THEME_COLOR_KEYS, EDITOR_THEME_SCOPES, type ResolvedEditorThemes } from "../../../electron/editor-themes.cjs";
import {
  getMarkdownEditorFontStack,
  getRenderedMarkdownFontStack,
  getWysiwygEditorFontStack,
  DEFAULT_MARKDOWN_EDITOR_FONT_FAMILY,
  DEFAULT_WYSIWYG_EDITOR_FONT_FAMILY,
} from "@/lib/markdown-preferences";

export const NO_EDITOR_THEMES: ResolvedEditorThemes = { visual: null, source: null, latex: null };

/** The editor themes in effect, for what draws with them (fonts, PDF pages). */
export const EditorThemesContext = createContext<ResolvedEditorThemes>(NO_EDITOR_THEMES);

export function useResolvedEditorThemes() {
  return useContext(EditorThemesContext);
}

/** Font stacks from each editor's theme; previews and PDF export take the visual editor's text font. */
export function editorThemeFontStacks(themes: ResolvedEditorThemes) {
  const textFont = themes.visual?.textFont || DEFAULT_WYSIWYG_EDITOR_FONT_FAMILY;
  return {
    visual: getWysiwygEditorFontStack(textFont),
    rendered: getRenderedMarkdownFontStack(textFont),
    source: getMarkdownEditorFontStack(themes.source?.codeFont || DEFAULT_MARKDOWN_EDITOR_FONT_FAMILY),
    latex: getMarkdownEditorFontStack(themes.latex?.codeFont || DEFAULT_MARKDOWN_EDITOR_FONT_FAMILY),
  };
}

/**
 * Marks the page with the editor themes from Preferences → Markdown and
 * returns them for EditorThemesContext; the editors pick their colors up in
 * globals.css under [data-editor-theme-*]. Each themed editor gets its light
 * and dark colors as --libera-editor-<editor>-<light|dark>-<color>, so
 * switching the app theme needs no work here. Preferences sends new themes as
 * soon as they are saved.
 */
export function useEditorThemes(initialThemes: ResolvedEditorThemes) {
  const [themes, setThemes] = useState(initialThemes);
  useEffect(() => window.liberaWindow?.onEditorThemesChanged?.(setThemes), []);
  useEffect(() => {
    const root = document.documentElement;
    const properties: string[] = [];
    const attributes: string[] = [];
    for (const scope of EDITOR_THEME_SCOPES) {
      const theme = themes[scope];
      if (!theme) continue;
      attributes.push(`data-editor-theme-${scope}`);
      for (const appearance of ["light", "dark"] as const) {
        for (const key of EDITOR_THEME_COLOR_KEYS) {
          const property = `--libera-editor-${scope}-${appearance}-${key}`;
          root.style.setProperty(property, theme[appearance][key]);
          properties.push(property);
        }
      }
    }
    for (const attribute of attributes) root.setAttribute(attribute, "");
    return () => {
      for (const attribute of attributes) root.removeAttribute(attribute);
      for (const property of properties) root.style.removeProperty(property);
    };
  }, [themes]);
  return themes;
}
