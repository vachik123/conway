import React, { useEffect, useState, useCallback, useRef } from 'react';
import { createPortal } from 'react-dom';

interface EventDot {
  isSecurity: boolean;
  isCodeQuality: boolean;
  repo: string;
  timestamp: string;
}

interface DotMatrixProps {
  sessionStart: Date;
  batches: Array<EventDot[]>; // Each batch = one polling interval
}

interface TooltipData {
  dotId: string;
  x: number;
  y: number;
  horizontal: 'left' | 'right';
  vertical: 'top' | 'bottom';
  event: EventDot;
}

const DotMatrix: React.FC<DotMatrixProps> = ({
  sessionStart,
  batches
}) => {
  const [elapsed, setElapsed] = useState('0s');
  const [tooltip, setTooltip] = useState<TooltipData | null>(null);
  const [maxColumns, setMaxColumns] = useState(75);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const DOT_SIZE = 12;  // w-3 = 12px
    const GAP = 6;        // gap-1.5 = 6px
    const PADDING = 24;   // p-3 = 12px each side

    const calculate = () => {
      const availableWidth = el.clientWidth - PADDING;
      const cols = Math.max(1, Math.floor((availableWidth + GAP) / (DOT_SIZE + GAP)));
      setMaxColumns(cols);
    };

    calculate();
    const observer = new ResizeObserver(calculate);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const visibleBatches = batches.slice(-maxColumns);

  useEffect(() => {
    const interval = setInterval(() => {
      const now = Date.now();
      const diff = now - sessionStart.getTime();
      const seconds = Math.floor(diff / 1000);
      const minutes = Math.floor(seconds / 60);
      const hours = Math.floor(minutes / 60);

      if (hours > 0) {
        setElapsed(`${hours}h ${minutes % 60}m`);
      } else if (minutes > 0) {
        setElapsed(`${minutes}m ${seconds % 60}s`);
      } else {
        setElapsed(`${seconds}s`);
      }
    }, 1000);

    return () => clearInterval(interval);
  }, [sessionStart]);

  const getDotColor = (isSecurity: boolean, isCodeQuality: boolean) => {
    if (isSecurity && isCodeQuality) {
      return 'bg-gradient-to-r from-rose-500 to-amber-500';
    } else if (isSecurity) {
      return 'bg-rose-500';
    } else if (isCodeQuality) {
      return 'bg-amber-500';
    } else {
      return 'bg-slate-200';
    }
  };

  const handleDotHover = useCallback((e: React.MouseEvent<HTMLDivElement>, dotId: string, event: EventDot) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const tooltipWidth = 200;
    const tooltipHeight = 80;
    const spaceRight = window.innerWidth - rect.right;
    const spaceLeft = rect.left;
    const spaceBottom = window.innerHeight - rect.bottom;

    const horizontal = spaceRight >= tooltipWidth || spaceRight > spaceLeft ? 'right' : 'left';
    const vertical = spaceBottom >= tooltipHeight ? 'bottom' : 'top';

    setTooltip({
      dotId,
      x: horizontal === 'right' ? rect.right + 8 : rect.left - 8,
      y: vertical === 'bottom' ? rect.bottom + 8 : rect.top - 8,
      horizontal,
      vertical,
      event,
    });
  }, []);

  const handleDotLeave = useCallback(() => setTooltip(null), []);

  return (
    <div className="bg-white/80 backdrop-blur-sm rounded-2xl border border-slate-200 p-4 sm:p-6">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h3 className="text-xs font-bold text-slate-900 uppercase tracking-wider">Event Timeline</h3>
          <p className="text-[10px] text-slate-500 mt-0.5">Each column = 10 events from one polling batch</p>
        </div>
        <div className="text-right">
          <div className="text-xs font-mono text-slate-600">
            {sessionStart.toLocaleTimeString()}
          </div>
          <div className="text-[10px] text-slate-500">
            Monitoring for {elapsed}
          </div>
        </div>
      </div>

      <div ref={containerRef} className="relative border border-slate-100 rounded-lg p-3 bg-slate-50/50 overflow-hidden">
        <div className="flex gap-1.5 pb-2">
          {visibleBatches.length === 0 ? (
            <div className="w-full text-center py-8 text-slate-400 text-xs">
              Waiting for events...
            </div>
          ) : (
            visibleBatches.map((batch, batchIndex) => (
              <div key={batchIndex} className="flex flex-col gap-1.5 flex-shrink-0">
                {batch.map((event, eventIndex) => {
                  const color = getDotColor(event.isSecurity, event.isCodeQuality);
                  const dotId = `${batchIndex}-${eventIndex}`;

                  return (
                    <div
                      key={eventIndex}
                      className={`w-3 h-3 rounded ${color} transition-all shadow-sm cursor-pointer hover:scale-110 hover:shadow-md`}
                      onMouseEnter={(e) => handleDotHover(e, dotId, event)}
                      onMouseLeave={handleDotLeave}
                    />
                  );
                })}
              </div>
            ))
          )}
        </div>
      </div>

      {tooltip && createPortal(
        <div
          className="fixed z-[99999] pointer-events-none"
          style={{
            left: tooltip.horizontal === 'right' ? tooltip.x : undefined,
            right: tooltip.horizontal === 'left' ? window.innerWidth - tooltip.x : undefined,
            top: tooltip.vertical === 'bottom' ? tooltip.y : undefined,
            bottom: tooltip.vertical === 'top' ? window.innerHeight - tooltip.y : undefined,
          }}
        >
          <div className="bg-slate-900 text-white text-xs rounded px-2 py-1.5 shadow-lg whitespace-nowrap">
            <div className="font-semibold">
              {tooltip.event.isSecurity && tooltip.event.isCodeQuality
                ? 'Security + Code Quality'
                : tooltip.event.isSecurity
                ? 'Security'
                : tooltip.event.isCodeQuality
                ? 'Code Quality'
                : 'Normal'}
            </div>
            <div className="text-slate-300">{tooltip.event.repo}</div>
            <div className="text-slate-400 text-[10px]">{new Date(tooltip.event.timestamp).toLocaleString()}</div>
          </div>
        </div>,
        document.body
      )}

      <div className="flex flex-wrap items-center gap-3 sm:gap-4 pt-3 border-t border-slate-100 mt-4">
        <div className="flex items-center gap-1.5">
          <div className="w-3 h-3 rounded bg-rose-500" />
          <span className="text-[10px] text-slate-600 font-medium">Security</span>
        </div>
        <div className="flex items-center gap-1.5">
          <div className="w-3 h-3 rounded bg-amber-500" />
          <span className="text-[10px] text-slate-600 font-medium">Code Quality</span>
        </div>
        <div className="flex items-center gap-1.5">
          <div className="w-3 h-3 rounded bg-gradient-to-r from-rose-500 to-amber-500" />
          <span className="text-[10px] text-slate-600 font-medium">Both</span>
        </div>
        <div className="flex items-center gap-1.5">
          <div className="w-3 h-3 rounded bg-slate-200" />
          <span className="text-[10px] text-slate-600 font-medium">Normal</span>
        </div>
      </div>
    </div>
  );
};

export default DotMatrix;
