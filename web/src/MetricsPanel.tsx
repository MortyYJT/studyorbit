import { useEffect, useState, type FormEvent } from 'react';
import { ClientError, type Client } from './client.js';
import type { Copy, Language } from './i18n.js';
import { costText, defaultRange, kindLabel, loadMetrics, metricsCards, rangeInput, type DateRange, type Metrics } from './metrics.js';
export function MetricsPanel({ client, t, language, timeZone: owner }: { client: Client; t: Copy; language: Language; timeZone?: string }) {
  const timeZone = owner ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const [dates, setDates] = useState<DateRange>(() => defaultRange(new Date(), timeZone));
  const [data, setData] = useState<{ range: DateRange; metrics: Metrics }>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  async function load(more = false) {
    const range = more ? data?.range : rangeInput(dates, timeZone);
    if (!range) { setError('INVALID_RANGE'); return; }
    setLoading(true); setError(undefined);
    try { setData({ range, metrics: await loadMetrics(client, range, more ? data?.metrics : undefined) }); }
    catch (caught) { setError(caught instanceof ClientError ? caught.code : 'SOURCE_UNAVAILABLE'); }
    finally { setLoading(false); }
  }
  // Load the default range once when the panel opens; later loads are explicit.
  useEffect(() => { void load(); }, []);
  function submit(event: FormEvent) { event.preventDefault(); void load(); }
  const agent = data?.metrics.agent.available ? data.metrics.agent : undefined;
  const totals = (row: { steps: number; turns: number; cost: Parameters<typeof costText>[0] }) => <><td>{row.steps}</td><td>{row.turns}</td><td>{costText(row.cost, t, language)}{row.cost.unknownCount ? ` · ${t.mCostUnknown}: ${row.cost.unknownCount}` : ''}</td></>;
  return <>
    <form className="metrics-range" onSubmit={submit} aria-label={t.mRange}>
      <label>{t.mFrom}<input type="date" value={dates.from} max={dates.to} onChange={event => setDates({ ...dates, from: event.target.value })} required /></label>
      <label>{t.mTo}<input type="date" value={dates.to} min={dates.from} onChange={event => setDates({ ...dates, to: event.target.value })} required /></label>
      <button type="submit" disabled={loading}>{t.mShow}</button>
    </form>
    <p className="muted">{t.mZone} {timeZone}</p>
    {error && <p role="status">{error === 'INVALID_RANGE' ? t.mRangeInvalid : `${t.error} (${error})`}</p>}
    {loading && <p role="status">{t.loading}</p>}
    {data && <div className="kpis">{metricsCards(data.metrics, t, language).map(card => <section className="kpi" key={card.key} aria-label={card.title}>
      <h3>{card.title}</h3>
      {card.value === undefined ? <p className="muted">{card.reason}</p> : <><div className="kpi-value">{card.value}</div>
        <dl>{card.facts.flatMap(([label, value]) => [<dt key={`${label}-t`}>{label}</dt>, <dd key={`${label}-d`}>{value}</dd>])}</dl>
        {card.note && <p className="muted">{card.note}</p>}</>}
    </section>)}</div>}
    {agent && <>
      <h3>{t.mByKind}</h3>
      <div className="table-wrap"><table><thead><tr><th>{t.mKind}</th><th>{t.mCount}</th><th>{t.mSteps}</th><th>{t.mTurns}</th><th>{t.mCost}</th></tr></thead>
        <tbody>{agent.byKind.map(row => <tr key={row.kind}><td>{kindLabel(row.kind, t)}</td><td>{row.count}</td>{totals(row)}</tr>)}</tbody></table></div>
      <h3>{t.mDetail}</h3>
      <div className="table-wrap"><table><thead><tr><th>{t.mConversation}</th><th>{t.mKind}</th><th>{t.mSteps}</th><th>{t.mTurns}</th><th>{t.mCost}</th></tr></thead>
        <tbody>{agent.conversations.map(row => <tr key={row.conversationId}><td><code>{row.conversationId}</code></td><td>{kindLabel(row.kind, t)}</td>{totals(row)}</tr>)}</tbody></table></div>
      {agent.nextCursor !== undefined && <button disabled={loading} onClick={() => void load(true)}>{t.more}</button>}
    </>}
  </>;
}
