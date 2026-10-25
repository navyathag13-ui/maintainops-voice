// Confirmation rules, enforced in code rather than left to the prompt.
// The LLM can *ask* to submit at any time; submitLog() refuses unless these pass.

const YES = /\b(yes|yeah|yep|yup|correct|confirm(ed)?|that'?s right|right|go ahead|submit( it)?|send it|do it|sounds good|looks good|affirmative|ok(ay)?)\b/i;
const NO = /\b(no|nope|not|don'?t|wait|hold on|stop|cancel|wrong|change|actually|instead|but)\b/i;

// A plain "yes" counts. "Yes but it was three belts" does not: any correction
// word means the technician is changing something, so the draft must be
// re-proposed and read back again.
export function isConfirmation(utterance: string): boolean {
  const text = utterance.trim();
  if (!text) return false;
  return YES.test(text) && !NO.test(text);
}

const CANCEL = /\b(cancel|never ?mind|forget (it|that)|scrap (it|that)|don'?t (log|save|submit))\b/i;

export function isCancel(utterance: string): boolean {
  return CANCEL.test(utterance);
}

export interface PendingProposal {
  // Turn number in which the draft was read back to the technician.
  proposedAtTurn: number;
}

export type SubmitGate = { allowed: true } | { allowed: false; reason: string };

export function canSubmit(
  pending: PendingProposal | null,
  currentTurn: number,
  lastUserUtterance: string,
): SubmitGate {
  if (!pending) {
    return { allowed: false, reason: "No log has been proposed yet. Call propose_log first." };
  }
  if (pending.proposedAtTurn >= currentTurn) {
    return {
      allowed: false,
      reason: "The technician has not heard the summary yet. Read it back and ask them to confirm.",
    };
  }
  if (!isConfirmation(lastUserUtterance)) {
    return {
      allowed: false,
      reason: "The technician's last reply was not a clear confirmation. Ask again or apply their correction.",
    };
  }
  return { allowed: true };
}
