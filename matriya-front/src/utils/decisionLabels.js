/** Hebrew display labels for composeAnswer decision_status (UI only). */
export function labelDecisionStatus(status) {
  const s = String(status || '');
  const map = {
    VALID_CONCLUSION: 'מסקנה תקפה',
    INCONCLUSIVE: 'לא חד-משמעי',
    INSUFFICIENT_DATA: 'חוסר נתונים',
    NO_CHANGE: 'אין שינוי',
    REFERENCE_ONLY: 'הקשר בלבד (לא מסקנה)',
    INVALID_EXPERIMENT: 'ניסוי לא תקין',
    STRUCTURAL_INCOMPLETE: 'מבנה לא שלם',
  };
  return map[s] || s || '—';
}
