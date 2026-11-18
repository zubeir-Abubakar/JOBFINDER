"use client";

import { useRef, useState } from "react";
import { sanitizeRichText } from "@/lib/rich-text";

type Props = {
  name: string;
  defaultValue: string;
  placeholder?: string;
  minHeight?: number;
  ariaLabel: string;
};

export function RichTextEditor({ name, defaultValue, placeholder, minHeight = 92, ariaLabel }: Props) {
  const editor = useRef<HTMLDivElement>(null);
  const [value, setValue] = useState(() => sanitizeRichText(defaultValue));
  const [active, setActive] = useState<string[]>([]);

  function sync() {
    const html = editor.current?.innerHTML ?? "";
    setValue(html);
    const commands = ["bold", "underline", "insertUnorderedList", "insertOrderedList"];
    setActive(commands.filter((command) => document.queryCommandState(command)));
  }

  function command(name: string) {
    const host = editor.current;
    host?.focus();
    document.execCommand(name, false);
    sync();
    // execCommand does not consistently emit input; wake the dirty-state form.
    host?.dispatchEvent(new Event("input", { bubbles: true }));
  }

  return (
    <div className="rich-editor">
      <div className="rich-toolbar" role="toolbar" aria-label={`Formatting for ${ariaLabel}`}>
        <button type="button" className={`rich-tool ${active.includes("bold") ? "is-active" : ""}`} onMouseDown={(event) => event.preventDefault()} onClick={() => command("bold")} aria-label="Bold" title="Bold">
          <strong>B</strong>
        </button>
        <button type="button" className={`rich-tool ${active.includes("underline") ? "is-active" : ""}`} onMouseDown={(event) => event.preventDefault()} onClick={() => command("underline")} aria-label="Underline" title="Underline">
          <u>U</u>
        </button>
        <span className="rich-divider" />
        <button type="button" className={`rich-tool ${active.includes("insertUnorderedList") ? "is-active" : ""}`} onMouseDown={(event) => event.preventDefault()} onClick={() => command("insertUnorderedList")} aria-label="Bulleted list" title="Bulleted list">
          • List
        </button>
        <button type="button" className={`rich-tool ${active.includes("insertOrderedList") ? "is-active" : ""}`} onMouseDown={(event) => event.preventDefault()} onClick={() => command("insertOrderedList")} aria-label="Numbered list" title="Numbered list">
          1. List
        </button>
        <button type="button" className="rich-tool" onMouseDown={(event) => event.preventDefault()} onClick={() => command("insertParagraph")} aria-label="New paragraph" title="New paragraph">
          ¶
        </button>
      </div>
      <div
        ref={editor}
        className="rich-surface"
        contentEditable
        suppressContentEditableWarning
        role="textbox"
        aria-multiline="true"
        aria-label={ariaLabel}
        data-placeholder={placeholder ?? ""}
        style={{ minHeight }}
        onInput={sync}
        onKeyUp={sync}
        onMouseUp={sync}
        dangerouslySetInnerHTML={{ __html: value }}
      />
      <input type="hidden" name={name} value={value} />
    </div>
  );
}
