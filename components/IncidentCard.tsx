import React from 'react';
import { IncidentSummary } from '../types';
import { Activity, Zap, AlertCircle } from 'lucide-react';

interface IncidentCardProps {
  incident: IncidentSummary;
  onClick: (incident: IncidentSummary) => void;
  onRetry?: (incident: IncidentSummary) => void;
  color: 'rose' | 'amber' | 'slate';
}

const COLOR_CLASSES = {
  rose: {
    border: 'border-rose-200',
    hover: 'hover:border-rose-300 hover:shadow-rose-100',
    badge: 'bg-rose-50 border-rose-200',
  },
  amber: {
    border: 'border-amber-200',
    hover: 'hover:border-amber-300 hover:shadow-amber-100',
    badge: 'bg-amber-50 border-amber-200',
  },
  slate: {
    border: 'border-slate-100',
    hover: 'hover:border-slate-200',
    badge: 'bg-slate-50 border-slate-200',
  },
};

const IncidentCard: React.FC<IncidentCardProps> = ({ incident, onClick, onRetry, color }) => {
  const colors = COLOR_CLASSES[color];

  return (
    <div
      onClick={() => onClick(incident)}
      className={`group relative bg-white border ${colors.border} rounded-xl p-3 sm:p-4 hover:shadow-lg ${colors.hover} transition-all cursor-pointer`}
    >
      <div className="flex-1 min-w-0 py-1">
        <div className="flex flex-wrap items-center gap-1.5 sm:gap-2.5 mb-1.5">
          <h3 className="text-sm font-bold text-slate-900 truncate max-w-[60%] sm:max-w-none">
            {incident.repo}
          </h3>
          <span className={`text-[10px] sm:text-xs font-mono text-slate-500 px-1.5 py-0.5 rounded-md border ${colors.badge} shrink-0`}>
            {incident.eventType}
          </span>
        </div>

        <div className="text-xs sm:text-sm text-slate-600 truncate pr-2 sm:pr-8">
          {incident.oneLineSummary ? (
            <span className="text-slate-700 font-medium">{incident.oneLineSummary}</span>
          ) : incident.summaryLoading ? (
            <span className="flex items-center gap-2 text-slate-500 text-xs font-medium">
              <Zap className="w-3 h-3" /> Analyzing...
            </span>
          ) : incident.summaryError ? (
            <span className="flex items-center gap-2 text-red-600 text-xs font-medium">
              <AlertCircle className="w-3 h-3" /> Error fetching summary
              {onRetry && (
                <button
                  onClick={(e) => { e.stopPropagation(); onRetry(incident); }}
                  className="ml-0.5 text-red-500 hover:text-red-700 font-semibold underline"
                >
                  Retry
                </button>
              )}
            </span>
          ) : (
            <span className="text-slate-400 italic">Waiting for analysis...</span>
          )}
        </div>

        <div className="flex items-center gap-4 mt-2.5 text-xs text-slate-400 font-medium">
          <div className="text-slate-600">
            {incident.actor}
          </div>
          <div className="flex items-center gap-1">
            <Activity className="w-3 h-3" />
            {new Date(incident.timestamp).toLocaleTimeString()}
          </div>
        </div>
      </div>

      {incident.summaryLoading && (
        <div className="absolute bottom-0 left-0 h-[2px] bg-slate-300 w-full rounded-b-xl"></div>
      )}
    </div>
  );
};

export default IncidentCard;
