/**
 * Persistent Storage Manager
 * Path: js/storage.js
 * Handles saving/loading AI knowledge and match stats via LocalStorage.
 */

(function (window) {
  'use strict';

  var STORAGE_KEYS = {
    AI_MEMORY: 'kamen_rider_ai_knowledge',
    LEGACY_AI_MEMORY: 'rider_fighting_game_ai_memory',
    MATCH_STATS: 'rider_fighting_game_stats'
  };

  /**
   * Saves the current AI knowledge base to LocalStorage.
   */
  function saveAIKnowledge() {
    if (window.globalAIKnowledge && typeof window.globalAIKnowledge.serialize === 'function') {
      try {
        var data = window.globalAIKnowledge.serialize();
        localStorage.setItem(STORAGE_KEYS.AI_MEMORY, data);
      } catch (e) {
        console.warn("Failed to save AI knowledge to LocalStorage:", e);
      }
    }
  }

  /**
   * Loads stored AI knowledge into globalAIKnowledge on game boot.
   */
  function loadAIKnowledge() {
    if (window.globalAIKnowledge && typeof window.globalAIKnowledge.deserialize === 'function') {
      try {
        var data = localStorage.getItem(STORAGE_KEYS.AI_MEMORY) || localStorage.getItem(STORAGE_KEYS.LEGACY_AI_MEMORY);
        if (data) {
          window.globalAIKnowledge.deserialize(data);
        }
      } catch (e) {
        console.warn("Failed to load AI knowledge from LocalStorage:", e);
      }
    }
  }

  /**
   * Saves match outcome stats (wins, total matches).
   */
  function recordMatchStats(result) {
    try {
      var stats = loadBattleStats();
      stats.totalMatches = (stats.totalMatches || 0) + 1;
      
      var winnerId = (result && result.winner) ? result.winner.id : 'draw';
      stats.riderWins = stats.riderWins || {};
      stats.riderWins[winnerId] = (stats.riderWins[winnerId] || 0) + 1;

      localStorage.setItem(STORAGE_KEYS.MATCH_STATS, JSON.stringify(stats));
    } catch (e) {
      console.warn("Failed to record match stats:", e);
    }
  }

  /**
   * Retrieves match history stats.
   */
  function loadBattleStats() {
    try {
      var raw = localStorage.getItem(STORAGE_KEYS.MATCH_STATS);
      return raw ? JSON.parse(raw) : { totalMatches: 0, riderWins: {} };
    } catch (e) {
      return { totalMatches: 0, riderWins: {} };
    }
  }

  /**
   * Clears saved AI memory to reset learning.
   */
  function clearAIMemory() {
    try {
      localStorage.removeItem(STORAGE_KEYS.AI_MEMORY);
      localStorage.removeItem(STORAGE_KEYS.LEGACY_AI_MEMORY);
      if (window.globalAIKnowledge) {
        window.globalAIKnowledge.memoryStore = {};
        window.globalAIKnowledge.playerProfiles = {};
      }
    } catch (e) {
      console.warn("Failed to clear AI memory:", e);
    }
  }

  /**
   * Clears saved match history statistics.
   */
  function clearBattleStats() {
    try {
      localStorage.removeItem(STORAGE_KEYS.MATCH_STATS);
    } catch (e) {
      console.warn("Failed to clear battle stats:", e);
    }
  }

  // Global Exports
  window.STORAGE_KEYS = STORAGE_KEYS;
  window.saveAIKnowledge = saveAIKnowledge;
  window.loadAIKnowledge = loadAIKnowledge;
  window.recordMatchStats = recordMatchStats;
  window.loadBattleStats = loadBattleStats;
  window.clearAIMemory = clearAIMemory;
  window.clearBattleStats = clearBattleStats;

  // Auto-load AI knowledge on script initialization
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', loadAIKnowledge);
  } else {
    loadAIKnowledge();
  }

})(window);
