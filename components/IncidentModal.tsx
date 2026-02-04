import React from 'react';
import { IncidentSummary } from '../types';
import { X, AlertCircle, TrendingDown, ArrowRight, User, Calendar } from 'lucide-react';

interface IncidentModalProps {
  incident: IncidentSummary | null;
  onClose: () => void;
}

const IncidentModal: React.FC<IncidentModalProps> = ({ incident, onClose }) => {
  if (!incident) return null;

  const hasRawData = (incident.rawSummary && Object.keys(incident.rawSummary).length > 0) ||
                     (incident.rawPayload && Object.keys(incident.rawPayload).length > 0);

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center sm:p-4 bg-black/50 backdrop-blur-sm" onClick={onClose}>
      <div
        className="bg-white w-full max-w-3xl rounded-t-2xl sm:rounded-lg shadow-xl overflow-hidden max-h-[90vh] flex flex-col"
        onClick={e => e.stopPropagation()}
      >
        <div className="p-4 sm:p-6 border-b border-gray-100 flex justify-between items-start">
            <div className="flex-1 min-w-0">
                <h2 className="text-lg sm:text-xl font-bold text-gray-900 mb-2 truncate">{incident.repo}</h2>
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs sm:text-sm text-gray-500">
                    <span className="font-mono">{incident.eventType}</span>
                    <span className="hidden sm:inline">•</span>
                    <div className="flex items-center gap-1">
                        <User className="w-3 h-3" />
                        {incident.actor}
                    </div>
                    <span className="hidden sm:inline">•</span>
                    <div className="flex items-center gap-1">
                        <Calendar className="w-3 h-3" />
                        {new Date(incident.timestamp).toLocaleString()}
                    </div>
                </div>
            </div>
            <button onClick={onClose} className="text-gray-400 hover:text-gray-600 transition-colors ml-2">
                <X className="w-6 h-6" />
            </button>
        </div>

        <div className="p-4 sm:p-6 overflow-y-auto">
            <div>
            {incident.summaryLoading && (
                <div className="mb-6 border border-gray-200 rounded-lg p-6 text-center">
                    <div className="animate-spin w-8 h-8 border-4 border-gray-300 border-t-gray-900 rounded-full mx-auto mb-3"></div>
                    <p className="text-sm text-gray-900 font-medium">Generating AI summary...</p>
                    <p className="text-xs text-gray-500 mt-1">This may take a few seconds</p>
                </div>
            )}

            {incident.summaryError && (
                <div className="mb-6 bg-red-50 border border-red-300 rounded-lg p-4">
                    <div className="flex items-center gap-2 mb-1">
                        <AlertCircle className="w-5 h-5 text-red-600" />
                        <p className="text-sm text-red-800 font-bold">Error fetching AI summary</p>
                    </div>
                    <p className="text-xs text-red-600 ml-7">{incident.summaryError}</p>
                </div>
            )}

            {incident.rootCause && incident.rootCause.length > 0 && (
                <>
                    <div className="mb-6">
                        <div className="flex items-center gap-2 mb-3">
                            <AlertCircle className="w-4 h-4 text-gray-600" />
                            <h3 className="text-xs font-semibold text-gray-600 uppercase tracking-wider">Root Cause</h3>
                        </div>
                        <ul className="space-y-2">
                            {incident.rootCause.map((cause, idx) => (
                                <li key={idx} className="flex items-start gap-3 text-sm text-gray-800 border-l-2 border-gray-300 pl-3 py-1">
                                    <span className="text-gray-400 font-mono text-xs shrink-0">
                                        {idx + 1}.
                                    </span>
                                    <span>{cause}</span>
                                </li>
                            ))}
                        </ul>
                    </div>

                    {incident.impact && incident.impact.length > 0 && (
                        <div className="mb-6">
                            <div className="flex items-center gap-2 mb-3">
                                <TrendingDown className="w-4 h-4 text-gray-600" />
                                <h3 className="text-xs font-semibold text-gray-600 uppercase tracking-wider">Impact</h3>
                            </div>
                            <ul className="space-y-2">
                                {incident.impact.map((item, idx) => (
                                    <li key={idx} className="flex items-start gap-3 text-sm text-gray-800 border-l-2 border-gray-300 pl-3 py-1">
                                        <span className="text-gray-400 font-mono text-xs shrink-0">
                                            {idx + 1}.
                                        </span>
                                        <span>{item}</span>
                                    </li>
                                ))}
                            </ul>
                        </div>
                    )}

                    {incident.nextSteps && incident.nextSteps.length > 0 && (
                        <div className="mb-6">
                            <div className="flex items-center gap-2 mb-3">
                                <ArrowRight className="w-4 h-4 text-gray-600" />
                                <h3 className="text-xs font-semibold text-gray-600 uppercase tracking-wider">Next Steps</h3>
                            </div>
                            <ul className="space-y-2">
                                {incident.nextSteps.map((step, idx) => (
                                    <li key={idx} className="flex items-start gap-3 text-sm text-gray-800 border-l-2 border-gray-300 pl-3 py-1">
                                        <span className="text-gray-400 font-mono text-xs shrink-0">
                                            {idx + 1}.
                                        </span>
                                        <span>{step}</span>
                                    </li>
                                ))}
                            </ul>
                        </div>
                    )}
                </>
            )}

            {incident.category === 'code_quality' && incident.codeQualityScore !== undefined && (
                <div className="mb-4">
                    <h3 className="text-xs font-semibold text-gray-600 uppercase tracking-wider mb-1">Code Quality Score</h3>
                    <div className="text-sm font-mono text-gray-900">{incident.codeQualityScore.toFixed(3)}</div>
                </div>
            )}
            {incident.category === 'security' && incident.mlScore !== undefined && (
                <div className="mb-4">
                    <h3 className="text-xs font-semibold text-gray-600 uppercase tracking-wider mb-1">Anomaly Score</h3>
                    <div className="text-sm font-mono text-gray-900">{incident.mlScore.toFixed(3)}</div>
                </div>
            )}
            </div>

            {hasRawData && (
                <div className="mt-6 border-t border-gray-200 pt-6">
                    {incident.rawSummary && Object.keys(incident.rawSummary).length > 0 && (
                        <div className="mb-4">
                            <h3 className="text-xs font-semibold text-gray-600 uppercase tracking-wider mb-2">Raw Summary</h3>
                            <pre className="bg-gray-50 p-3 rounded text-[10px] font-mono overflow-x-auto border border-gray-200 text-gray-600 leading-relaxed">
                                {JSON.stringify(incident.rawSummary, null, 2)}
                            </pre>
                        </div>
                    )}
                    {incident.rawPayload && Object.keys(incident.rawPayload).length > 0 && (
                        <div className="mb-4">
                            <h3 className="text-xs font-semibold text-gray-600 uppercase tracking-wider mb-2">Raw Event</h3>
                            <pre className="bg-gray-50 p-3 rounded text-[10px] font-mono overflow-x-auto border border-gray-200 text-gray-600 leading-relaxed">
                                {JSON.stringify(incident.rawPayload, null, 2)}
                            </pre>
                        </div>
                    )}
                </div>
            )}
        </div>
      </div>
    </div>
  );
};

export default IncidentModal;