import { Shield, Lock, CheckCircle } from 'lucide-react';

const BADGE_CONFIG: Record<string, {
  style: string;
  label: string;
  icon: JSX.Element;
}> = {
  ACTIVE_ATTACK: {
    style: "bg-red-100 text-red-700 border-red-200",
    label: "Active Attack",
    icon: <Shield className="w-3 h-3 mr-1" />
  },
  POLICY_VIOLATION: {
    style: "bg-amber-100 text-amber-700 border-amber-200",
    label: "Policy Violation",
    icon: <Lock className="w-3 h-3 mr-1" />
  },
  BENIGN_ANOMALY: {
    style: "bg-blue-50 text-blue-600 border-blue-200",
    label: "Benign Anomaly",
    icon: <CheckCircle className="w-3 h-3 mr-1" />
  }
};

const VerdictBadge = ({ classification }: { classification?: string }) => {
  if (!classification) return null;

  const current = BADGE_CONFIG[classification] || BADGE_CONFIG['POLICY_VIOLATION'];

  return (
    <span className={`flex items-center text-[10px] font-bold px-2 py-0.5 rounded border ${current.style}`}>
      {current.icon}
      {current.label}
    </span>
  );
};

export default VerdictBadge;
