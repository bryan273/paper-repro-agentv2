import { useEffect, useMemo, useState } from 'react';
import { ArrowDownToLine, ArrowLeft, Check, ChevronRight, FileText, Pause, Play, RotateCcw } from 'lucide-react';
import { LanguageSwitch, translator, stageLabel, type Language } from '@/lib/i18n';
import { Dialog, DialogContent, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { asset, download, duration, eventText, label, loadEvents, type RecordedRun, type RunEvent } from '@/lib/replay';

const stages = ['reader', 'router', 'planner', 'implementer', 'verifier'];
export default function RunViewer({ run, onClose, language, onLanguageChange }: { run: RecordedRun; onClose: () => void; language: Language; onLanguageChange: (language: Language) => void }) {
  const t = translator(language);
  const [events, setEvents] = useState<RunEvent[]>([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [retry, setRetry] = useState(0);
  const [time, setTime] = useState(run.seconds);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(20);
  const [tab, setTab] = useState('timeline');
  const [filter, setFilter] = useState('all');
  const [page, setPage] = useState(0);
  const [pdfPage, setPdfPage] = useState(1);
  useEffect(() => { let active = true; setLoading(true); setError(''); loadEvents(run.file).then(data => { if (active) { setEvents(data); setTime(run.seconds); } }).catch(() => { if (active) setError('Could not load the event log. Check the connection and retry.'); }).finally(() => { if (active) setLoading(false); }); return () => { active = false; }; }, [run.file, run.seconds, retry]);
  useEffect(() => { if (!playing) return; const id = setInterval(() => setTime(value => Math.min(run.seconds, value + speed / 4)), 250); return () => clearInterval(id); }, [playing, speed, run.seconds]);
  const revealed = useMemo(() => events.filter(e => e.t <= time + 0.1), [events, time]);
  const currentStage = revealed.filter(e => e.type === 'stage_start').at(-1)?.stage;
  const contract = revealed.find(e => e.type === 'contract');
  const fullContract = revealed.find(e => e.type === 'contract_full');
  const verdict = revealed.find(e => e.type === 'verdict');
  const filtered = useMemo(() => { let stage = ''; return revealed.filter(e => { if (e.type === 'stage_start') stage = String(e.stage); return filter === 'all' || stage === filter; }); }, [revealed, filter]);
  const count = Math.max(1, Math.ceil(filtered.length / 30));
  const safePage = Math.min(page, count - 1);
  function exportReport() {
    download(`${run.id}-recorded-report.md`, `# ${run.title}

## 中文报告
仅为录制回放证据，未执行新实验。
实验：${run.id}
结论：${translator('zh')(label(run.verdict))}
耗时：${duration(run.seconds)}
录制估算成本：¥${run.cost_cny}

## English report
Recorded replay evidence only; no new experiment was executed.
Run: ${run.id}
Verdict: ${run.verdict}
Duration: ${duration(run.seconds)}
Estimated recorded cost: ¥${run.cost_cny}

## 原始结论事件 / Original verdict event
\`\`\`json
${JSON.stringify(events.find(e => e.type === 'verdict'), null, 2)}
\`\`\`

完整事件链请下载原始 JSONL。 / Download the original JSONL for the complete event trail.
`);
  }
  return <Dialog open onOpenChange={open => { if (!open) onClose(); }}><DialogContent closeLabel={t('Close')} className="replay-dialog" aria-describedby="replay-description"><header className="viewer-header"><button className="icon-button" aria-label={t('Back to dashboard')} onClick={onClose}><ArrowLeft size={19} /></button><div><DialogTitle>{run.title}</DialogTitle><DialogDescription id="replay-description">{t('RECORDED REPLAY')} · {run.id}</DialogDescription></div><LanguageSwitch language={language} onChange={onLanguageChange} /><button className="secondary" disabled={loading || !!error} onClick={exportReport}><ArrowDownToLine size={15} />{t('Report')}</button></header>
    {loading ? <div className="viewer-message">{t('Loading original recorded evidence…')}</div> : error ? <div className="viewer-message" role="alert">{t(error)}<button className="secondary" onClick={() => setRetry(v => v + 1)}>{t('Retry')}</button></div> : <><div className="stage-bar">{stages.map((stage, index) => <button className={currentStage === stage ? 'stage active' : 'stage'} key={stage} onClick={() => { const start = events.find(e => e.type === 'stage_start' && e.stage === stage); if (start) { setTime(start.t); setPlaying(false); setFilter(stage); setTab('timeline'); setPage(0); } }}><span>{index + 1}</span>{t(stageLabel(stage))}{index < 4 && <ChevronRight size={14} />}</button>)}</div>
    <div className="playback"><button className="icon-button" aria-label={playing && time < run.seconds ? t('Pause replay') : t('Play replay')} onClick={() => { if (time >= run.seconds) setTime(0); setPlaying(!(playing && time < run.seconds)); }}>{playing && time < run.seconds ? <Pause size={18} /> : <Play size={18} />}</button><input aria-label={t('Replay time')} type="range" min="0" max={run.seconds} step="0.1" value={time} onChange={e => { setTime(Number(e.target.value)); setPlaying(false); }} /><span>{duration(time)} / {duration(run.seconds)}</span><select aria-label={t('Playback speed')} value={speed} onChange={e => setSpeed(Number(e.target.value))}><option value={1}>1×</option><option value={20}>20×</option><option value={100}>100×</option></select><button className="secondary compact" onClick={() => { setTime(run.seconds); setPlaying(false); setFilter('all'); setTab('verdict'); }}>{t('View verdict')}</button></div>
    <div className="viewer-grid"><section className="paper-panel"><div className="panel-heading"><span><FileText size={16} />{t('Original paper')}</span><a href={asset(run.pdf)} target="_blank" rel="noreferrer">{t('Open PDF ↗')}</a></div><iframe key={pdfPage} title={`${run.title} PDF · ${language === 'zh' ? '页' : 'page'} ${pdfPage}`} src={`${asset(run.pdf)}#page=${pdfPage}`} /><p className="pdf-note">{t('If the embedded viewer is unavailable, use “Open PDF”.')}</p></section><section className="evidence-panel"><div className="evidence-tabs">{['timeline', 'contract', 'verdict'].map(name => <button key={name} className={tab === name ? 'selected' : ''} onClick={() => setTab(name)}>{t(name.charAt(0).toUpperCase() + name.slice(1))}</button>)}<a href={asset(run.file)} download aria-label={t('Download original JSONL events')}><ArrowDownToLine size={16} /></a></div><div className="evidence-scroll"><p className="data-note">{t('Original evidence is preserved in its source language; interface text follows your language choice.')}</p>
    {tab === 'timeline' && <><div className="timeline-controls"><select aria-label={t('Filter by stage')} value={filter} onChange={e => { setFilter(e.target.value); setPage(0); }}><option value="all">{t('All stages')}</option>{stages.map(s => <option key={s} value={s}>{t(stageLabel(s))}</option>)}</select><span>{filtered.length} {t('original events')}</span></div>{filtered.slice(safePage * 30, safePage * 30 + 30).map((e, index) => <details className="event" key={`${e.seq}-${index}`}><summary><span className="event-time">{duration(e.t)}</span><span className="event-kind">{t(label(e.type))}</span><p>{eventText(e).slice(0, 200)}</p></summary><pre>{JSON.stringify(e, null, 2)}</pre></details>)}<div className="pagination"><button className="secondary compact" disabled={safePage === 0} onClick={() => setPage(safePage - 1)}>{t('Previous')}</button><span>{safePage + 1} / {count}</span><button className="secondary compact" disabled={safePage >= count - 1} onClick={() => setPage(safePage + 1)}>{t('Next')}</button></div></>}
    {tab === 'contract' && (contract ? <><h3>{t('Claim contract')}</h3><p>{String(contract.summary ?? '')}</p><details open className="json-section"><summary>{t('Original target & tolerance')}</summary><pre>{JSON.stringify({ target: contract.target, tolerance: contract.tolerance }, null, 2)}</pre></details><h3>{t('Paper evidence')}</h3>{(['claims', 'requirements', 'assumptions'] as const).map(key => <section key={key}><h4>{t(label(key))}</h4>{(Array.isArray(fullContract?.[key]) ? fullContract[key] as Record<string, unknown>[] : []).map((item, i) => <details className="requirement" key={i}><summary>{String(item.id ?? i + 1)} · {String(item.stmt ?? item.statement ?? item.gap ?? t('Evidence'))}</summary>{!!item.page && <button className="secondary compact" onClick={() => setPdfPage(Number(item.page))}>{language === 'zh' ? `跳转至论文第 ${item.page} 页` : `Go to paper page ${item.page}`}</button>}<pre>{JSON.stringify(item, null, 2)}</pre></details>)}</section>)}</> : <p>{t('The Reader has not produced a contract at this replay time.')}</p>)}
    {tab === 'verdict' && (verdict ? <><span className={`status ${run.verdict === 'reproduced' ? 'success' : 'partial'}`}>{run.verdict === 'reproduced' ? <Check size={14} /> : <RotateCcw size={14} />}{t(label(String(verdict.verdict)))}</span><h3>{t('Clean re-run verdict')}</h3><p>{String(verdict.reason ?? '')}</p><div className="metric-pair"><div><small>{t('Paper target')}</small><strong>{String((verdict.target as Record<string, unknown>)?.value ?? '—')}</strong></div><div><small>{t('Measured')}</small><strong>{String(verdict.measured ?? '—')}</strong></div></div><h4>{t("Verifier's audit")}</h4><p>{String(verdict.audit_summary ?? t('See original verdict event below.'))}</p><details className="json-section"><summary>{t('Full original verdict & requirement audit')}</summary><pre>{JSON.stringify(verdict, null, 2)}</pre></details><p className="data-note">{t('This verdict is from the uploaded recording. It is not an independent validation performed by this frontend.')}</p></> : <p>{t('The verifier has not completed at this replay time. Use “View verdict” to jump to the recorded result.')}</p>)}
    </div></section></div></>}
  </DialogContent></Dialog>;
}
