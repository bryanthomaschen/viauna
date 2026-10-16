import Image from "@tiptap/extension-image";
import Placeholder from "@tiptap/extension-placeholder";
import { type Editor as TiptapEditor, EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { Bold, Italic, Link, List, ListOrdered, RemoveFormatting, Strikethrough, TextQuote, Underline } from "lucide-react";
import { useEffect, useReducer, useRef } from "react";
import { IconButton } from "./common";

const MAX_INLINE_IMAGE = 5 * 1024 * 1024;

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });
}

/** Pasted/dropped images go inline (sent as cid parts); the server converts data: URLs. */
async function insertImages(editor: TiptapEditor, files: File[]): Promise<boolean> {
  const images = files.filter((f) => /^image\/(png|jpe?g|gif|webp)$/.test(f.type) && f.size <= MAX_INLINE_IMAGE);
  if (!images.length) return false;
  for (const f of images) {
    const src = await readAsDataUrl(f);
    editor.chain().focus().setImage({ src, alt: f.name }).run();
  }
  return true;
}

export function useMailEditor(initialHtml: string, placeholder: string, onChange: (html: string) => void, autofocus: boolean) {
  const ref = useRef<TiptapEditor | null>(null);
  const editor = useEditor({
    extensions: [
      StarterKit.configure({ link: { openOnClick: false, autolink: true, HTMLAttributes: { rel: "noopener noreferrer", target: "_blank" } }, heading: false, codeBlock: false }),
      Placeholder.configure({ placeholder }),
      Image.configure({ inline: true, allowBase64: true }),
    ],
    content: initialHtml,
    autofocus: autofocus ? "start" : false,
    onUpdate: ({ editor: e }) => onChange(e.getHTML()),
    editorProps: {
      attributes: { "aria-label": "Message body", role: "textbox", "aria-multiline": "true" },
      handlePaste: (_view, event) => {
        const files = Array.from(event.clipboardData?.files ?? []);
        if (!ref.current || !files.some((f) => f.type.startsWith("image/"))) return false;
        void insertImages(ref.current, files);
        return true;
      },
      handleDrop: (_view, event) => {
        const files = Array.from((event as DragEvent).dataTransfer?.files ?? []);
        // Only images go inline; other files bubble up to become attachments.
        if (!ref.current || !files.length || !files.every((f) => f.type.startsWith("image/"))) return false;
        event.preventDefault();
        void insertImages(ref.current, files);
        return true;
      },
    },
  });
  ref.current = editor;
  return editor;
}

export function EditorArea({ editor }: { editor: TiptapEditor | null }) {
  return (
    <div className="compose-editor" onClick={() => editor?.chain().focus().run()}>
      <EditorContent editor={editor} />
    </div>
  );
}

export function FormatBar({ editor }: { editor: TiptapEditor | null }) {
  // Re-render on selection changes so active states are right.
  const [, force] = useReducer((x: number) => x + 1, 0);
  useEffect(() => {
    if (!editor) return;
    editor.on("transaction", force);
    return () => {
      editor.off("transaction", force);
    };
  }, [editor]);
  if (!editor) return null;
  const btn = (label: string, active: boolean, run: () => void, icon: React.ReactNode) => (
    <IconButton label={label} className={active ? "on" : ""} onMouseDown={(e) => e.preventDefault()} onClick={run}>
      {icon}
    </IconButton>
  );
  const c = () => editor.chain().focus();
  return (
    <div className="format-bar" role="toolbar" aria-label="Formatting">
      {btn("Bold (Ctrl+B)", editor.isActive("bold"), () => c().toggleBold().run(), <Bold size={16} />)}
      {btn("Italic (Ctrl+I)", editor.isActive("italic"), () => c().toggleItalic().run(), <Italic size={16} />)}
      {btn("Underline (Ctrl+U)", editor.isActive("underline"), () => c().toggleUnderline().run(), <Underline size={16} />)}
      {btn("Strikethrough", editor.isActive("strike"), () => c().toggleStrike().run(), <Strikethrough size={16} />)}
      {btn("Insert link (Ctrl+K)", editor.isActive("link"), () => {
        const prev = editor.getAttributes("link").href as string | undefined;
        const url = window.prompt("Link to (URL or email):", prev ?? "https://");
        if (url === null) return;
        if (!url.trim()) return void c().unsetLink().run();
        const href = /^[^\s@]+@[^\s@]+$/.test(url.trim()) ? `mailto:${url.trim()}` : /^(https?:|mailto:)/i.test(url.trim()) ? url.trim() : `https://${url.trim()}`;
        if (editor.state.selection.empty) c().insertContent(`<a href="${href.replace(/"/g, "&quot;")}">${url.trim().replace(/</g, "&lt;")}</a> `).run();
        else c().setLink({ href }).run();
      }, <Link size={16} />)}
      {btn("Bulleted list", editor.isActive("bulletList"), () => c().toggleBulletList().run(), <List size={16} />)}
      {btn("Numbered list", editor.isActive("orderedList"), () => c().toggleOrderedList().run(), <ListOrdered size={16} />)}
      {btn("Quote", editor.isActive("blockquote"), () => c().toggleBlockquote().run(), <TextQuote size={16} />)}
      {btn("Remove formatting", false, () => c().unsetAllMarks().clearNodes().run(), <RemoveFormatting size={16} />)}
    </div>
  );
}

