/**
 * Vision payload sanitization (Phase 1.7) — trace/plan redaction seam.
 *
 * The engine records tool payloads on traces and plans via
 * `sanitizeDesktopPayload`. Vision payloads need the SAME treatment and a
 * little more: `desktop.visualType` carries user-typed `text` that must never
 * persist. This module composes AFTER the desktop sanitizer so each tool id is
 * handled by the sanitizer that knows it (desktop.type → desktop, visualType →
 * here).
 *
 * The real string still travels: to the desktop backend (execution) and back
 * to the model that invented it — it just never lands in a durable record.
 * Screenshot bytes and raw OCR text never enter tool payloads at all.
 */
export function sanitizeVisionPayload(
  toolId: string,
  payload: Record<string, unknown>,
): Record<string, unknown> {
  if (toolId !== 'desktop.visualType') return payload
  if (typeof payload['text'] !== 'string') return payload
  return { ...payload, text: '[redacted]' }
}