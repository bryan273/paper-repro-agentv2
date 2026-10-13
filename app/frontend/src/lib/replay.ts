export interface Demo { id: string; route: string; title: string; paper: string; repo: string | null; target_hint: string; scenario: string; replay: string; pdf: string }
export interface RecordedRun { id: string; file: string; title: string; verdict: string; route: string; seconds: number; cost_cny: number; demo_id: string; pdf: string }
export interface RunEvent { type: string; t: number; seq?: number; stage?: string; role?: string; [key: string]: unknown }
export const asset = (name: string) => `/assets/demo-runs/${encodeURIComponent(name)}`;
export const label = (text: string) => text.replaceAll('_', ' ');
export const duration = (seconds: number) => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;
export async function loadJson<T>(url: string): Promise<T> { const response = await fetch(url); if (!response.ok) throw new Error(`Could not load recorded data (${response.status}).`); return response.json(); }
export async function loadEvents(file: string): Promise<RunEvent[]> { const response = await fetch(asset(file)); if (!response.ok) throw new Error(`Could not load event log (${response.status}).`); return (await response.text()).split(/\r?\n/).filter(line => line.trim()).map(line => JSON.parse(line) as RunEvent); }
export function eventText(event: RunEvent): string { for (const key of ['title', 'text', 'delta', 'note', 'reason', 'summary', 'approach', 'why', 'statement', 'gap', 'instruction']) { if (typeof event[key] === 'string') return event[key] as string; } return JSON.stringify(event, null, 2); }
export function download(name: string, text: string, type = 'text/markdown') { const url = URL.createObjectURL(new Blob([text], { type })); const a = document.createElement('a'); a.href = url; a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); }
