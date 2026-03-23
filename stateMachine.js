/**
 * State Machine for managing information states and decisions
 * States: K (Known), C (Checked), B (Blocked), N (New), L (Limited)
 */
import logger from './logger.js';
import { sanitizeAnswerWhenNoSupportClaimed, hasVectorSearchEvidence } from './lib/ragEvidenceFailSafe.js';

const State = {
  K: "K",  // Known - Verified and approved
  C: "C",  // Checked - Under review
  B: "B",  // Blocked - Rejected/blocked
  N: "N",  // New - Initial state
  L: "L"   // Limited - Restricted access
};

const KernelDecision = {
  ALLOW: "allow",
  BLOCK: "block",
  STOP: "stop"
};

class StateMachine {
  /**State Machine for managing information states*/
  
  // Valid state transitions
  static TRANSITIONS = {
    [State.N]: [State.C, State.K, State.B, State.L],  // New can go to any state
    [State.C]: [State.K, State.B, State.L],  // Checked can be approved, blocked, or limited
    [State.K]: [State.C, State.B, State.L],  // Known can be re-checked, blocked, or limited
    [State.B]: [State.C, State.N],  // Blocked can be re-checked or reset
    [State.L]: [State.C, State.K, State.B]  // Limited can be checked, approved, or blocked
  };
  
  constructor(db = null) {
    /**
     * Initialize State Machine
     * 
     * Args:
     *   db: Optional database session (not currently used, reserved for future audit logging)
     */
    this.db = db;
  }
  
  getState(queryId) {
    /**Get current state for a query/decision*/
    // In a full implementation, this would query a state_history table
    // For now, return default state N (New)
    return State.N;
  }
  
  canTransition(fromState, toState) {
    /**Check if transition is valid*/
    return StateMachine.TRANSITIONS[fromState]?.includes(toState) || false;
  }
  
  transition(queryId, fromState, toState, reason = "") {
    /**Transition to new state and log the change*/
    if (!this.canTransition(fromState, toState)) {
      logger.warn(`Invalid transition from ${fromState} to ${toState}`);
      return false;
    }
    
    // Log state transition
    logger.info(`State transition: ${queryId} ${fromState} -> ${toState} (${reason})`);
    
    // In a full implementation, this would:
    // 1. Save to state_history table
    // 2. Update current state
    // 3. Create audit log entry
    
    return true;
  }
  
  logStateChange(queryId, state, decision, reason = "") {
    /**Log state change for audit trail*/
    // Handle both enum and string values
    const stateVal = typeof state === 'object' ? state : String(state);
    const decisionVal = typeof decision === 'object' ? decision : String(decision);
    logger.info(`State change logged: ${queryId} -> ${stateVal}, Decision: ${decisionVal}, Reason: ${reason}`);
    // In production, save to audit_log table
  }
}

class Kernel {
  /**
   * Kernel - Supreme authority over all user responses
   * Orchestrates: User Intent → Agents → Decision (Allow/Block/Stop)
   */
  
  constructor(ragService, stateMachine) {
    this.ragService = ragService;
    this.stateMachine = stateMachine;
  }
  
  async processUserIntent(query, userId = null, context = null, filterMetadata = null, options = null) {
    /**
     * Process user intent through the Kernel system
     * 
     * Flow: User Intent → Kernel → Agents → Kernel → Decision
     * 
     * Args:
     *   query: User's question/intent
     *   user_id: Optional user ID for permissions
     *   context: Optional context from previous interactions
     * 
     * Returns:
     *   Dictionary with decision, answer, state, and agent results
     */
    const queryId = `query_${Date.now()}`;
    const initialState = State.N; // Start with New state
    
    logger.info(`Kernel processing user intent: ${queryId}`);
    
    // Step 1: Get initial answer from Doc Agent
    let docAgentResult = null;
    let docAnswer = null;
    let docContext = null;
    let docSearchResults = [];
    
    try {
      if (context) {
        // Use provided context
        docContext = context;
        // Generate answer from context
        if (this.ragService.llmService.isAvailable()) {
          docAnswer = await this.ragService.llmService.generateAnswer(query, docContext);
        }
      } else {
        // Get answer from RAG (Doc Agent) — deeper retrieval when cloud doc search is on / all documents
        const nDoc = this.ragService.getDocAgentRetrievalCount(filterMetadata);
        const prefetched =
          options && Array.isArray(options.prefetchedSearchResults) ? options.prefetchedSearchResults : null;
        const docResult = await this.ragService.generateAnswer(query, nDoc, filterMetadata, true, prefetched);
        docAnswer = docResult.answer;
        docContext = docResult.context || '';
        docSearchResults = docResult.results || [];
        docAgentResult = docResult;
      }
      
      if (!docAnswer) {
        // No answer from Doc Agent - Stop
        this.stateMachine.logStateChange(queryId, State.B, KernelDecision.STOP, "No answer from Doc Agent");
        return {
          decision: KernelDecision.STOP,
          state: State.B,
          answer: null,
          reason: 'לא נמצאה תשובה במסמכים',
          agent_results: {
            doc_agent: { status: 'no_answer' }
          }
        };
      }

      if (!context) {
        if (!hasVectorSearchEvidence(docSearchResults, 12)) {
          this.stateMachine.logStateChange(queryId, State.B, KernelDecision.STOP, 'No substantive RAG evidence');
          return {
            decision: KernelDecision.STOP,
            state: State.B,
            answer: null,
            reason: 'לא נמצאה תשובה במסמכים',
            agent_results: {
              doc_agent: { status: 'no_answer', reason: 'no_substantive_evidence' }
            }
          };
        }
      }

      docAnswer = sanitizeAnswerWhenNoSupportClaimed(docAnswer);
    } catch (e) {
      logger.error(`Doc Agent error: ${e.message}`);
      this.stateMachine.logStateChange(queryId, State.B, KernelDecision.STOP, `Doc Agent error: ${e.message}`);
      return {
        decision: KernelDecision.STOP,
        state: State.B,
        answer: null,
        reason: 'שגיאה בקבלת תשובה',
        agent_results: {
          doc_agent: { status: 'error', error: e.message }
        }
      };
    }
    
    // Step 2 & 3: Skip Contradiction and Risk Agents for now
    // (User requested to accept all answers and only run Doc Agent)
    const contradictionResult = null;
    const hasContradictions = false;
    const riskResult = null;
    const hasRisks = false;
    
    // Step 4: Kernel Decision Logic - Always Allow for now
    const decision = KernelDecision.ALLOW;
    const newState = State.K; // Always set to Known (approved)
    const reason = "תשובה מאושרת";
    this.stateMachine.transition(queryId, initialState, newState, reason);
    
    // Log final decision
    this.stateMachine.logStateChange(queryId, newState, decision, reason);
    
    // Step 5: Return result
    const result = {
      decision: decision,
      state: newState,
      answer: docAnswer,
      reason: reason,
      query_id: queryId,
      context: docContext,  // Include context for agent checks
      search_results: docSearchResults,  // Include search results
      agent_results: {
        doc_agent: {
          status: 'success',
          answer: docAnswer,
          context_sources: docAgentResult?.context_used || 0,
          results_count: docSearchResults.length
        },
        contradiction_agent: {
          status: 'skipped',
          has_contradictions: false,
          analysis: null
        },
        risk_agent: {
          status: 'skipped',
          has_risks: false,
          analysis: null
        }
      }
    };
    
    return result;
  }
}

export { StateMachine, Kernel, State, KernelDecision };
