import { useEffect, useState } from "react";
import { useEditor, EditorContent, type Editor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import {
  Bold, Italic, Strikethrough, List, ListOrdered,
  Heading2, Heading3, Quote, Minus, Undo, Redo, Maximize2, Minimize2,
} from "lucide-react";

interface RichTextEditorProps {
  value: string;
  onChange: (html: string) => void;
  placeholder?: string;
  minHeight?: number;
}

function ToolbarBtn({ onClick, active, disabled, title, children }: {
  onClick: () => void; active?: boolean; disabled?: boolean; title: string; children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      title={title}
      disabled={disabled}
      onMouseDown={e => { e.preventDefault(); onClick(); }}
      className={`p-1.5 rounded-lg transition-colors disabled:opacity-30 disabled:cursor-not-allowed ${active ? "bg-accent text-white" : "hover:bg-muted text-muted-foreground hover:text-foreground"}`}
    >
      {children}
    </button>
  );
}

function Toolbar({ editor, isFullscreen, onToggleFullscreen }: { editor: Editor; isFullscreen: boolean; onToggleFullscreen: () => void }) {
  return (
    <div className="flex flex-wrap items-center gap-0.5 px-3 py-2 border-b bg-muted/30">
      <ToolbarBtn title="Bold" active={editor.isActive("bold")} onClick={() => editor.chain().focus().toggleBold().run()}><Bold className="h-4 w-4" /></ToolbarBtn>
      <ToolbarBtn title="Italic" active={editor.isActive("italic")} onClick={() => editor.chain().focus().toggleItalic().run()}><Italic className="h-4 w-4" /></ToolbarBtn>
      <ToolbarBtn title="Strikethrough" active={editor.isActive("strike")} onClick={() => editor.chain().focus().toggleStrike().run()}><Strikethrough className="h-4 w-4" /></ToolbarBtn>
      <div className="w-px h-5 bg-border mx-1" />
      <ToolbarBtn title="Heading 2" active={editor.isActive("heading", { level: 2 })} onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()}><Heading2 className="h-4 w-4" /></ToolbarBtn>
      <ToolbarBtn title="Heading 3" active={editor.isActive("heading", { level: 3 })} onClick={() => editor.chain().focus().toggleHeading({ level: 3 }).run()}><Heading3 className="h-4 w-4" /></ToolbarBtn>
      <div className="w-px h-5 bg-border mx-1" />
      <ToolbarBtn title="Bullet List" active={editor.isActive("bulletList")} onClick={() => editor.chain().focus().toggleBulletList().run()}><List className="h-4 w-4" /></ToolbarBtn>
      <ToolbarBtn title="Numbered List" active={editor.isActive("orderedList")} onClick={() => editor.chain().focus().toggleOrderedList().run()}><ListOrdered className="h-4 w-4" /></ToolbarBtn>
      <ToolbarBtn title="Quote" active={editor.isActive("blockquote")} onClick={() => editor.chain().focus().toggleBlockquote().run()}><Quote className="h-4 w-4" /></ToolbarBtn>
      <ToolbarBtn title="Divider" onClick={() => editor.chain().focus().setHorizontalRule().run()}><Minus className="h-4 w-4" /></ToolbarBtn>
      <div className="w-px h-5 bg-border mx-1" />
      <ToolbarBtn title="Undo" disabled={!editor.can().undo()} onClick={() => editor.chain().focus().undo().run()}><Undo className="h-4 w-4" /></ToolbarBtn>
      <ToolbarBtn title="Redo" disabled={!editor.can().redo()} onClick={() => editor.chain().focus().redo().run()}><Redo className="h-4 w-4" /></ToolbarBtn>
      <div className="ml-auto"><ToolbarBtn title={isFullscreen ? "Exit fullscreen" : "Expand to fullscreen"} onClick={onToggleFullscreen}>{isFullscreen ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}</ToolbarBtn></div>
    </div>
  );
}

export function RichTextEditor({ value, onChange, placeholder = "Write your content here...", minHeight = 300 }: RichTextEditorProps) {
  const editor = useEditor({
    extensions: [StarterKit.configure({ heading: { levels: [2, 3] } })],
    content: value || "",
    editorProps: {
      attributes: {
        class: "px-4 py-4 text-sm leading-relaxed outline-none prose prose-sm max-w-none focus:outline-none",
        style: `min-height:${minHeight}px`,
      },
    },
    onUpdate: ({ editor }) => { onChange(editor.getHTML()); },
  });

  useEffect(() => {
    if (!editor || editor.isFocused) return;
    const current = editor.getHTML();
    if (value !== current && !(value === "" && current === "<p></p>")) {
      editor.commands.setContent(value || "", false);
    }
  }, [value, editor]);

  const [isFullscreen, setIsFullscreen] = useState(false);

  if (!editor) return null;
  const isEmpty = editor.isEmpty;

  return (
    <div className={isFullscreen ? "fixed inset-0 z-50 bg-background flex flex-col" : "border border-input rounded-xl overflow-hidden focus-within:ring-2 focus-within:ring-ring focus-within:ring-offset-0"}>
      <Toolbar editor={editor} isFullscreen={isFullscreen} onToggleFullscreen={() => setIsFullscreen(v => !v)} />
      <div className={isFullscreen ? "relative flex-1 overflow-y-auto" : "relative"}>
        {isEmpty && (
          <p className="absolute top-4 left-4 text-muted-foreground text-sm pointer-events-none select-none">
            {placeholder}
          </p>
        )}
        <EditorContent editor={editor} className={isFullscreen ? "h-full" : ""} />
      </div>
    </div>
  );
}
