import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { subscribeToBackendStream, getEventSummary, fetchEvents, resetAll } from './services/backendStream';
import { IncidentSummary } from './types';
import IncidentCard from './components/IncidentCard';
import IncidentModal from './components/IncidentModal';
import DotMatrix from './components/DotMatrix';
import { Activity, Shield, AlertTriangle, Search, RotateCcw } from 'lucide-react';

const MAX_INCIDENTS = 100;
const DISPLAY_LIMIT = 10;
const BACKEND_URL = (typeof import.meta !== 'undefined' && (import.meta as any).env?.VITE_BACKEND_URL) ||
                    (import.meta.env?.PROD ? '' : 'http://localhost:3001');

function sortIncidentsByTimestamp(incidents: IncidentSummary[]): IncidentSummary[] {
  return incidents.sort((a, b) => {
    const timeDiff = new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime();
    return timeDiff !== 0 ? timeDiff : a.id.localeCompare(b.id, undefined, { numeric: true });
  });
}

function updateIncidentById(eventId: string, updates: Partial<IncidentSummary>) {
  return (inc: IncidentSummary) =>
    inc.id === eventId ? { ...inc, ...updates } : inc;
}

function markIncidentError(eventId: string, errorMessage: string) {
  return (inc: IncidentSummary) =>
    inc.id === eventId
      ? { ...inc, summaryLoading: false, summaryError: errorMessage }
      : inc;
}

function App() {
  const [securityIncidents, setSecurityIncidents] = useState<IncidentSummary[]>([]);
  const [codeQualityIncidents, setCodeQualityIncidents] = useState<IncidentSummary[]>([]);
  const [selectedIncident, setSelectedIncident] = useState<IncidentSummary | null>(null);
  const [isConnected, setIsConnected] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');
  const [sessionStart] = useState(new Date());

  const fetchingSummariesRef = useRef<Set<string>>(new Set());
  const [totalSecurityCount, setTotalSecurityCount] = useState(0);
  const [totalCodeQualityCount, setTotalCodeQualityCount] = useState(0);
  const [totalNormalCount, setTotalNormalCount] = useState(0);
  const [dotMatrixBatches, setDotMatrixBatches] = useState<Array<Array<{
    isSecurity: boolean;
    isCodeQuality: boolean;
    repo: string;
    timestamp: string;
  }>>>([]);
  const [isResetting, setIsResetting] = useState(false);
  const pendingBatchRef = React.useRef<Array<{
    isSecurity: boolean;
    isCodeQuality: boolean;
    repo: string;
    timestamp: string;
  }>>([]);
  const batchTimerRef = React.useRef<NodeJS.Timeout | null>(null);

  const stats = useMemo(() => {
    return {
      security: totalSecurityCount,
      codeQuality: totalCodeQualityCount,
      normal: totalNormalCount,
      total: totalSecurityCount + totalCodeQualityCount + totalNormalCount,
    };
  }, [totalSecurityCount, totalCodeQualityCount, totalNormalCount]);

  const autoFetchSummary = useCallback(async (eventId: string, mlScore: number) => {
    if (fetchingSummariesRef.current.has(eventId)) return;
    fetchingSummariesRef.current.add(eventId);

    try {
      const summary = await getEventSummary(eventId);
      const rawParsed = JSON.parse(summary.raw_summary || '{}');

      const confidence = rawParsed.confidence;

      const updatedData = {
        oneLineSummary: rawParsed.one_line_summary,
        rootCause: summary.root_cause.split('\n').filter(Boolean),
        impact: summary.impact.split('\n').filter(Boolean),
        nextSteps: summary.next_steps.split('\n').filter(Boolean),
        summaryLoading: false,
      };

      const applyUpdate = updateIncidentById(eventId, updatedData);

      setSecurityIncidents((prev: IncidentSummary[]) => prev.map(applyUpdate));
      setCodeQualityIncidents((prev: IncidentSummary[]) => prev.map(applyUpdate));
      setSelectedIncident((prev: IncidentSummary | null) => prev?.id === eventId ? { ...prev, ...updatedData } : prev);

    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      console.error(`Auto-fetch failed for ${eventId}:`, errorMessage);
      const markError = markIncidentError(eventId, errorMessage);

      setSecurityIncidents((prev: IncidentSummary[]) => prev.map(markError));
      setCodeQualityIncidents((prev: IncidentSummary[]) => prev.map(markError));
    } finally {
      fetchingSummariesRef.current.delete(eventId);
    }
  }, []);

  useEffect(() => {
    const mapEvents = (events: any[]): IncidentSummary[] => {
      return events.map(e => {
        let oneLineSummary: string | undefined;
        let confidence: string | undefined;

        if (e.raw_summary) {
          try {
            const parsed = typeof e.raw_summary === 'string' ? JSON.parse(e.raw_summary) : e.raw_summary;
            oneLineSummary = parsed.one_line_summary;
            confidence = parsed.confidence;
          } catch (err) {
            console.error('Failed to parse raw_summary for event', e.event_id, ':', err);
            console.error('Raw summary data:', e.raw_summary);
          }
        }

        return {
          id: e.event_id,
          repo: e.repo,
          eventType: e.event_type,
          timestamp: e.timestamp,
          actor: e.actor,
          mlScore: e.score,
          codeQualityScore: e.code_quality_score,
          category: e.category,
          oneLineSummary,
          rootCause: e.root_cause ? e.root_cause.split('\n') : undefined,
          impact: e.impact ? e.impact.split('\n') : undefined,
          nextSteps: e.next_steps ? e.next_steps.split('\n') : undefined,
          rawPayload: e.raw_payload,
          repoContext: e.repo_context,
        };
      });
    };

    Promise.all([
      fetchEvents({ category: 'security', limit: 50 }),
      fetchEvents({ category: 'code_quality', limit: 50 }),
      fetchEvents({ category: 'normal', limit: 200 }),
      fetch(`${BACKEND_URL}/stats`)
        .then(res => res.json())
    ])
      .then(([security, codeQuality, normal, stats]) => {
        const mappedSecurity = mapEvents(security);
        const mappedCodeQuality = mapEvents(codeQuality);
        sortIncidentsByTimestamp(mappedSecurity);
        sortIncidentsByTimestamp(mappedCodeQuality);

        setSecurityIncidents(mappedSecurity);
        setCodeQualityIncidents(mappedCodeQuality);

        setTotalSecurityCount(stats.totalSecurity || security.length);
        setTotalCodeQualityCount(stats.totalCodeQuality || codeQuality.length);
        setTotalNormalCount(stats.totalNormal || 0);

        const allHistoricalEvents = [
          ...security.map((e: any) => ({ ...e, category: e.category || 'security' })),
          ...codeQuality.map((e: any) => ({ ...e, category: e.category || 'code_quality' })),
          ...normal.map((e: any) => ({ ...e, category: 'normal' }))
        ];

        // Sort events chronologically (ascending). Database already returns events in this order,
        // but we sort here as a safety net for consistency and to handle any client-side additions.
        allHistoricalEvents.sort((a, b) => {
          const timeDiff = new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime();
          if (timeDiff !== 0) return timeDiff;
          return a.event_id.localeCompare(b.event_id, undefined, { numeric: true });
        });

        const batches: Array<Array<{
          isSecurity: boolean;
          isCodeQuality: boolean;
          repo: string;
          timestamp: string;
        }>> = [];

        const MAX_BATCH_SIZE = 10;
        let currentBatch: Array<{
          isSecurity: boolean;
          isCodeQuality: boolean;
          repo: string;
          timestamp: string;
        }> = [];

        allHistoricalEvents.forEach((event: any) => {
          const category = event.category || 'normal';

          currentBatch.push({
            isSecurity: category === 'security' || category === 'both',
            isCodeQuality: category === 'code_quality' || category === 'both',
            repo: event.repo || 'unknown',
            timestamp: event.timestamp
          });

          if (currentBatch.length >= MAX_BATCH_SIZE) {
            batches.push([...currentBatch]);
            currentBatch = [];
          }
        });

        if (currentBatch.length > 0) {
          batches.push(currentBatch);
        }

        setDotMatrixBatches(batches.slice(-75));

        const incidentsNeedingSummary = [
          ...mappedSecurity.slice(0, DISPLAY_LIMIT).filter(inc => !inc.rootCause && !inc.summaryLoading),
          ...mappedCodeQuality.slice(0, DISPLAY_LIMIT).filter(inc => !inc.rootCause && !inc.summaryLoading),
        ];

        const uniqueIds = new Set<string>();
        const uniqueIncidents = incidentsNeedingSummary.filter(inc => {
          if (uniqueIds.has(inc.id)) return false;
          uniqueIds.add(inc.id);
          return true;
        });

        if (uniqueIncidents.length > 0) {
          uniqueIncidents.forEach(inc => autoFetchSummary(inc.id, inc.mlScore || 0));
        }
      })
      .catch((err: unknown) => {
        const errorMessage = err instanceof Error ? err.message : String(err);
        console.error('Failed to fetch history:', errorMessage);
      });

    const cleanup = subscribeToBackendStream(
      (data) => {
        if (data.type === 'event') {
          const newIncident: IncidentSummary = {
            id: data.event_id,
            repo: data.repo,
            eventType: data.event_type,
            timestamp: data.timestamp,
            actor: data.actor,
            mlScore: data.score,
            codeQualityScore: data.code_quality_score,
            category: data.category,
            rawPayload: data.raw_payload,
            summaryLoading: true,
          };

          const category = data.category ?? 'normal';
          const isSecurity = category === 'security' || category === 'both';
          const isCodeQuality = category === 'code_quality' || category === 'both';

          pendingBatchRef.current.push({
            isSecurity,
            isCodeQuality,
            repo: data.repo || 'unknown',
            timestamp: data.timestamp ?? new Date().toISOString()
          });

          if (pendingBatchRef.current.length >= 10) {
            if (batchTimerRef.current) {
              clearTimeout(batchTimerRef.current);
              batchTimerRef.current = null;
            }
            const completedBatch = [...pendingBatchRef.current];
            pendingBatchRef.current = [];
            setDotMatrixBatches(prev => [...prev, completedBatch].slice(-75));
          } else {
            if (batchTimerRef.current) {
              clearTimeout(batchTimerRef.current);
            }
            batchTimerRef.current = setTimeout(() => {
              if (pendingBatchRef.current.length > 0) {
                const partialBatch = [...pendingBatchRef.current];
                pendingBatchRef.current = [];
                setDotMatrixBatches(prev => [...prev, partialBatch].slice(-75));
              }
            }, 12000);
          }

          if (category === 'both') {
            setSecurityIncidents(prev => [...prev, newIncident].slice(-MAX_INCIDENTS));
            setCodeQualityIncidents(prev => [...prev, newIncident].slice(-MAX_INCIDENTS));
            setTotalSecurityCount(prev => prev + 1);
            setTotalCodeQualityCount(prev => prev + 1);
            autoFetchSummary(data.event_id, data.score || 0);
          } else if (category === 'security') {
            setSecurityIncidents(prev => [...prev, newIncident].slice(-MAX_INCIDENTS));
            setTotalSecurityCount(prev => prev + 1);
            autoFetchSummary(data.event_id, data.score || 0);
          } else if (category === 'code_quality') {
            setCodeQualityIncidents(prev => [...prev, newIncident].slice(-MAX_INCIDENTS));
            setTotalCodeQualityCount(prev => prev + 1);
            autoFetchSummary(data.event_id, data.score || 0);
          } else {
            setTotalNormalCount(prev => prev + 1);
          }
          setIsConnected(true);

        } else if (data.type === 'summary') {
          const updateIncident = (inc: IncidentSummary) => {
            if (inc.id === data.event_id) {
              let rawParsed: any = {};
              try {
                rawParsed = JSON.parse(data.raw_summary || '{}');
              } catch (e) {
                console.error('Failed to parse summary raw_summary:', e);
                console.error('Raw summary data:', data.raw_summary);
              }

              const confidence = rawParsed.confidence;

              return {
                ...inc,
                oneLineSummary: rawParsed.one_line_summary,
                rootCause: data.root_cause.split('\n').filter(Boolean),
                impact: data.impact.split('\n').filter(Boolean),
                nextSteps: data.next_steps.split('\n').filter(Boolean),
                summaryLoading: false,
              };
            }
            return inc;
          };

          setSecurityIncidents(prev => prev.map(updateIncident));
          setCodeQualityIncidents(prev => prev.map(updateIncident));
        } else if (data.type === 'reset') {
          setSecurityIncidents([]);
          setCodeQualityIncidents([]);
          setTotalSecurityCount(0);
          setTotalCodeQualityCount(0);
          setTotalNormalCount(0);
          setDotMatrixBatches([]);
          setSelectedIncident(null);
          pendingBatchRef.current = [];
          if (batchTimerRef.current) {
            clearTimeout(batchTimerRef.current);
            batchTimerRef.current = null;
          }
        }
      },
      (error) => {
        console.error('SSE Stream error:', error);
        console.error('Connection lost - attempting to reconnect...');
        setIsConnected(false);
      }
    );

    return cleanup;
  }, [autoFetchSummary]);

  const handleIncidentClick = async (incident: IncidentSummary) => {
    setSelectedIncident(incident);

    if (!incident.rootCause && !incident.summaryLoading) {
      const markLoading = (inc: IncidentSummary) =>
        inc.id === incident.id ? { ...inc, summaryLoading: true } : inc;

      setSecurityIncidents(prev => prev.map(markLoading));
      setCodeQualityIncidents(prev => prev.map(markLoading));

      try {
        const summary = await getEventSummary(incident.id);
        const rawParsed = JSON.parse(summary.raw_summary || '{}');

        const confidence = rawParsed.confidence;

        const updatedData = {
          oneLineSummary: rawParsed.one_line_summary,
          rootCause: summary.root_cause.split('\n').filter(Boolean),
          impact: summary.impact.split('\n').filter(Boolean),
          nextSteps: summary.next_steps.split('\n').filter(Boolean),
          summaryLoading: false,
        };

        const applyUpdate = updateIncidentById(incident.id, updatedData);

        setSecurityIncidents((prev: IncidentSummary[]) => prev.map(applyUpdate));
        setCodeQualityIncidents((prev: IncidentSummary[]) => prev.map(applyUpdate));
        setSelectedIncident(prev => prev?.id === incident.id ? { ...prev, ...updatedData } : prev);

      } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        console.error('Failed to load summary for event', incident.id);
        console.error('Error:', errorMessage);
        const markError = markIncidentError(incident.id, errorMessage);

        setSecurityIncidents((prev: IncidentSummary[]) => prev.map(markError));
        setCodeQualityIncidents((prev: IncidentSummary[]) => prev.map(markError));
        setSelectedIncident(prev => prev?.id === incident.id ? { ...prev, summaryLoading: false, summaryError: errorMessage } : prev);
      }
    }
  };

  const handleRetry = useCallback((incident: IncidentSummary) => {
    const markRetrying = (inc: IncidentSummary) =>
      inc.id === incident.id ? { ...inc, summaryError: undefined, summaryLoading: true } : inc;

    setSecurityIncidents(prev => prev.map(markRetrying));
    setCodeQualityIncidents(prev => prev.map(markRetrying));
    setSelectedIncident(prev => prev?.id === incident.id ? { ...prev, summaryError: undefined, summaryLoading: true } : prev);

    autoFetchSummary(incident.id, incident.mlScore || 0);
  }, [autoFetchSummary]);

  const handleReset = async () => {
    if (isResetting) return;

    setIsResetting(true);
    try {
      await resetAll();

      setSecurityIncidents([]);
      setCodeQualityIncidents([]);
      setTotalSecurityCount(0);
      setTotalCodeQualityCount(0);
      setTotalNormalCount(0);
      setDotMatrixBatches([]);
      setSelectedIncident(null);
      setSearchTerm('');

      pendingBatchRef.current = [];
      if (batchTimerRef.current) {
        clearTimeout(batchTimerRef.current);
        batchTimerRef.current = null;
      }

    } catch (error) {
      console.error('Failed to reset:', error);
    } finally {
      setIsResetting(false);
    }
  };

  const filterIncidents = (incidents: IncidentSummary[]) =>
    incidents.filter(inc =>
      inc.repo.toLowerCase().includes(searchTerm.toLowerCase()) ||
      inc.actor.toLowerCase().includes(searchTerm.toLowerCase())
    );

  const filteredSecurity = filterIncidents(securityIncidents);
  const filteredCodeQuality = filterIncidents(codeQualityIncidents);

  return (
    <>
      <div className="fixed inset-0 -z-10 bg-[#fafbfc]" />
      <div className="min-h-screen flex font-sans text-slate-800">

        <div className="flex-1 p-4 sm:p-6 md:p-8 overflow-y-auto h-screen">
          <div className="max-w-7xl mx-auto space-y-4 sm:space-y-6">

            <div className="flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-3">
              <div className="relative w-full sm:w-96 group">
                <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 text-slate-600 w-4 h-4 group-focus-within:text-slate-900 transition-colors z-10" />
                <input
                  type="text"
                  placeholder="Search actors, repositories..."
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                  className="w-full pl-10 pr-4 py-2 bg-white/60 backdrop-blur-sm border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-slate-900/10 focus:border-slate-300 transition-all"
                />
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={handleReset}
                  disabled={isResetting}
                  className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-500 bg-white/60 backdrop-blur-sm border border-slate-200 rounded-full hover:bg-slate-50 hover:text-slate-700 hover:border-slate-300 transition-all disabled:opacity-50 disabled:cursor-not-allowed"
                  title="Reset all data"
                >
                  <RotateCcw className={`w-3 h-3 ${isResetting ? 'animate-spin' : ''}`} />
                  <span className="hidden sm:inline">{isResetting ? 'Resetting...' : 'Reset'}</span>
                </button>
                <div className={`flex items-center justify-center sm:justify-start gap-2 text-xs font-semibold px-3 py-1.5 rounded-full border transition-all ${
                  isConnected
                    ? 'text-emerald-700 bg-emerald-50 border-emerald-200'
                    : 'text-amber-700 bg-amber-50 border-amber-200'
                }`}>
                  <span className="relative flex h-2 w-2">
                    <span className={`relative inline-flex rounded-full h-2 w-2 ${isConnected ? 'bg-emerald-500' : 'bg-amber-500'}`}></span>
                  </span>
                  {isConnected ? 'LIVE STREAM ACTIVE' : 'CONNECTING...'}
                </div>
              </div>
            </div>

            <DotMatrix
              sessionStart={sessionStart}
              batches={dotMatrixBatches}
            />

            <div className="bg-white/90 backdrop-blur-xl rounded-2xl sm:rounded-3xl shadow-soft border border-slate-200/60 p-4 sm:p-6 md:p-8 min-h-[85vh]">

              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 sm:gap-4 mb-6 sm:mb-10">
                {[
                  { label: "Total Events", value: stats.total, icon: Activity, color: "text-slate-600", bg: "bg-slate-50", border: "border-slate-200" },
                  { label: "Security", value: stats.security, icon: Shield, color: "text-rose-600", bg: "bg-rose-50", border: "border-rose-200" },
                  { label: "Code Quality", value: stats.codeQuality, icon: AlertTriangle, color: "text-amber-600", bg: "bg-amber-50", border: "border-amber-200" },
                ].map((stat, i) => (
                  <div key={i} className={`${stat.bg} border ${stat.border} rounded-2xl p-5`}>
                    <div className="flex items-center justify-between mb-3">
                      <span className={`text-[11px] font-bold uppercase tracking-wider ${stat.color} opacity-80`}>{stat.label}</span>
                      <stat.icon className={`w-4 h-4 ${stat.color}`} />
                    </div>
                    <div className={`text-3xl font-bold ${stat.color.replace('600', '900').replace('500', '700')}`}>{stat.value}</div>
                  </div>
                ))}
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">

                <div className="space-y-3">
                  <div className="flex items-center gap-3 px-2">
                    <Shield className="w-5 h-5 text-rose-600" />
                    <h2 className="text-sm font-bold text-rose-900 uppercase tracking-wider">Security Incidents</h2>
                    <span className="text-xs text-rose-500 bg-rose-50 px-2 py-0.5 rounded-full">
                      {filteredSecurity.slice(0, DISPLAY_LIMIT).length} of {stats.security}
                    </span>
                  </div>
                  {filteredSecurity.length === 0 ? (
                    <div className="bg-rose-50/30 border border-rose-100 rounded-xl p-6 text-center text-rose-400 text-sm">
                      No security incidents detected
                    </div>
                  ) : (
                    <div className="space-y-2">
                      {filteredSecurity.slice(0, DISPLAY_LIMIT).map((incident) => (
                        <IncidentCard key={incident.id} incident={incident} onClick={handleIncidentClick} onRetry={handleRetry} color="rose" />
                      ))}
                    </div>
                  )}
                </div>

                <div className="space-y-3">
                  <div className="flex items-center gap-3 px-2">
                    <AlertTriangle className="w-5 h-5 text-amber-600" />
                    <h2 className="text-sm font-bold text-amber-900 uppercase tracking-wider">Code Quality Issues</h2>
                    <span className="text-xs text-amber-500 bg-amber-50 px-2 py-0.5 rounded-full">
                      {filteredCodeQuality.slice(0, DISPLAY_LIMIT).length} of {stats.codeQuality}
                    </span>
                  </div>
                  {filteredCodeQuality.length === 0 ? (
                    <div className="bg-amber-50/30 border border-amber-100 rounded-xl p-6 text-center text-amber-400 text-sm">
                      No code quality issues detected
                    </div>
                  ) : (
                    <div className="space-y-2">
                      {filteredCodeQuality.slice(0, DISPLAY_LIMIT).map((incident) => (
                        <IncidentCard key={incident.id} incident={incident} onClick={handleIncidentClick} onRetry={handleRetry} color="amber" />
                      ))}
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      <IncidentModal
        incident={selectedIncident}
        onClose={() => setSelectedIncident(null)}
      />
    </>
  );
}

export default App;