import { useState } from "react";

interface Props {
  text: string;
  label?: string;
  /** Orange call-to-action style. */
  primary?: boolean;
  /** Menu-item style (no button chrome). */
  plain?: boolean;
}

export function CopyButton({ text, label = "Copy", primary, plain }: Props) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className={plain ? "menu-item" : `btn btn-small${primary ? " btn-primary" : ""}`}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
        } catch {
          window.prompt("Copy this:", text);
          return;
        }
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }}
    >
      {copied ? "Copied ✓" : label}
    </button>
  );
}
