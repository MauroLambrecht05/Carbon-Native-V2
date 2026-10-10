import { useEffect, useRef, useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useLocation } from "react-router-dom";
import { Feedback } from "../../components/Feedback";
import { useSession } from "../../framework/session/SessionProvider";
import type { CommandOptions, Result } from "../../framework/services/contracts";
import { unwrap } from "../../framework/services/contracts";
import type { CommandReceipt } from "../../framework/services/identity-contracts";

export type Field = { name: string; label: string; value?: string; type?: string; required?: boolean; options?: readonly { value: string; label: string }[]; secret?: boolean; maxLength?: number };
// Non-secret drafts survive session expiry in this tab, isolated by account and route.
const drafts = new Map<string, Record<string, string>>();
export function CommandForm({ title, fields = [], revision, submit, disabled, children, after, sensitive = false, preview }: {
  title: string; fields?: readonly Field[]; revision?: string; submit: (values: Record<string, string>, options: CommandOptions) => Promise<Result<CommandReceipt>>;
  disabled?: string; children?: ReactNode; after?: (result: CommandReceipt) => void; sensitive?: boolean;
  preview?: (values: Record<string, string>) => ReactNode;
}) {
  const { session } = useSession(), location = useLocation(), cache = useQueryClient();
  const draftKey = `${session?.accountId ?? "visitor"}:${location.pathname}:${title}`;
  const initial = Object.fromEntries(fields.map(f => [f.name, f.value ?? ""]));
  const [values, setValues] = useState<Record<string, string>>(() => ({ ...initial, ...drafts.get(draftKey) }));
  const [pending, setPending] = useState(false), [error, setError] = useState<unknown>(), [result, setResult] = useState<CommandReceipt>();
  const [key, setKey] = useState<string>(() => crypto.randomUUID());
  const dirty = useRef(false), submitting = useRef(false);
  const initialRevision = useRef(revision);
  useEffect(() => { if (!dirty.current && initialRevision.current !== revision) { initialRevision.current = revision; setValues(Object.fromEntries(fields.map(f => [f.name, f.value ?? ""]))); } }, [revision]);
  useEffect(() => {
    if (typeof window === "undefined" || typeof document === "undefined") return;
    const unload = (event: BeforeUnloadEvent) => { if (dirty.current) { event.preventDefault(); event.returnValue = ""; } };
    const click = (event: MouseEvent) => {
      const link = (event.target as Element)?.closest?.("a");
      if (link && dirty.current && !window.confirm("Leave this edited form? Non-secret fields are kept as a draft for this account and route.")) { event.preventDefault(); event.stopPropagation(); }
    };
    window.addEventListener("beforeunload", unload); document.addEventListener("click", click, true);
    return () => { window.removeEventListener("beforeunload", unload); document.removeEventListener("click", click, true); };
  }, []);
  return <form onSubmit={async event => {
    event.preventDefault(); if (submitting.current) return;
    submitting.current = true; setPending(true); setError(undefined); setResult(undefined);
    try {
      const receipt = unwrap(await submit(values, { idempotencyKey: key, expectedRevision: initialRevision.current }));
      dirty.current = false; drafts.delete(draftKey); setResult(receipt); setKey(crypto.randomUUID());
      await cache.invalidateQueries(); after?.(receipt);
    } catch (cause) { setError(cause); }
    finally { submitting.current = false; setPending(false); }
  }}>
    <h3>{title}</h3>
    {children}
    {preview?.(values)}
    <fieldset disabled={pending || !!disabled}>
      {fields.map(field => <label key={field.name}>{field.label}{field.options ? <select value={values[field.name]} onChange={e => change(field, e.target.value)}>{field.options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}</select> : field.type === "textarea" ? <textarea rows={7} required={field.required !== false} maxLength={field.maxLength ?? 1000000} value={values[field.name]} onChange={e => change(field, e.target.value)} /> : <input type={field.type ?? "text"} autoComplete={field.secret ? "off" : undefined} required={field.required !== false} maxLength={field.secret ? 200 : 254} value={values[field.name]} onChange={e => change(field, e.target.value)} />}</label>)}
      <button>{pending ? "Saving…" : title}</button>
    </fieldset>
    {disabled && <p className="muted">{disabled}</p>}
    {error !== undefined && <><Feedback error={error} /><button type="button" onClick={() => { initialRevision.current = revision; setKey(crypto.randomUUID()); setError(undefined); }}>Use latest revision ({revision}) and review draft</button></>}
    {result && <p role="status">{result.message}</p>}
    {result?.secretValue && <div className="notice"><p>Copy this fake credential now. Carbon Cloud stores only its prefix and cannot show it again.</p><pre>{result.secretValue}</pre><button type="button" onClick={() => setResult({ message: "Credential dismissed. Its value cannot be recovered." })}>I copied the credential</button></div>}
    {result?.recoveryCodes && !after && <div className="notice"><p>Save these recovery codes now. They are shown once; generating new codes invalidates the old set.</p><pre>{result.recoveryCodes.join("\n")}</pre><button type="button" onClick={() => setResult({ message: "Recovery codes dismissed." })}>I saved my codes</button></div>}
    {dirty.current && <button type="button" onClick={() => { drafts.delete(draftKey); setValues(initial); dirty.current = false; initialRevision.current = revision; }}>Discard draft</button>}
  </form>;
  function change(field: Field, value: string) {
    const next = { ...values, [field.name]: value }; setValues(next); dirty.current = true;
    if (!sensitive) drafts.set(draftKey, Object.fromEntries(fields.filter(f => !f.secret).map(f => [f.name, next[f.name]])));
  }
}
export const choices = (values: readonly string[]) => values.map(value => ({ value, label: value }));
