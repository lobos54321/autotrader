/**
 * AI-Powered Narrative System
 * 
 * Uses Grok AI to:
 * 1. Maintain a dynamic narrative database (weekly update)
 * 2. Assess individual tokens' narrative fit in real-time
 * 3. Score narratives based on market heat, lifecycle, sustainability
 * 
 * Architecture:
 * - NarrativeDatabase: SQLite table storing narrative metrics
 * - WeeklyUpdater: Cron job that asks Grok to reassess all narratives
 * - TokenAssessor: Real-time Grok call to identify token's narrative
 */

import GrokTwitterClient from '../social/grok-twitter-client.js';

export class AINarrativeSystem {
  constructor(config, db) {
    this.config = config;
    this.db = db;
    this.grokClient = new GrokTwitterClient();
    
    // Initialize database table
    this.initializeDatabase();
    
    // Load narratives into memory for fast lookup
    this.narrativesCache = new Map();
    this.loadNarrativesCache();
  }

  /**
   * Initialize narratives table in database
   */
  initializeDatabase() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS ai_narratives (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        narrative_name TEXT UNIQUE NOT NULL,
        
        -- Market metrics (0-10 scale)
        market_heat REAL DEFAULT 5,
        sustainability REAL DEFAULT 5,
        competition_level TEXT DEFAULT 'medium',
        
        -- Lifecycle stage
        lifecycle_stage TEXT DEFAULT 'unknown',
        lifecycle_multiplier REAL DEFAULT 1.0,
        
        -- Calculated weight (0-10)
        weight REAL DEFAULT 5,
        
        -- AI reasoning
        ai_reasoning TEXT,
        keywords TEXT,  -- JSON array of keywords
        
        -- Metadata
        last_updated INTEGER,
        update_source TEXT,  -- 'weekly_ai', 'manual', 'initial'
        
        created_at INTEGER DEFAULT (strftime('%s', 'now'))
      );
      
      CREATE INDEX IF NOT EXISTS idx_narrative_name ON ai_narratives(narrative_name);
      CREATE INDEX IF NOT EXISTS idx_narrative_weight ON ai_narratives(weight DESC);
    `);
    
    // Seed initial narratives if empty
    const count = this.db.prepare('SELECT COUNT(*) as count FROM ai_narratives').get();
    if (count.count === 0) {
      this.seedInitialNarratives();
    }
  }

  /**
   * Seed initial narratives based on December 2024 market data
   */
  seedInitialNarratives() {
    const initialNarratives = [
      {
        name: 'AI_Agents',
        market_heat: 9.2,
        sustainability: 7.5,
        competition_level: 'medium',
        lifecycle_stage: 'early_explosion',
        lifecycle_multiplier: 1.3,
        keywords: ['ai', 'agent', 'autonomous', 'llm', 'gpt', 'neural', 'bot', 'machine learning', 'artificial intelligence'],
        ai_reasoning: 'AI agents are the hottest narrative of late 2024. Projects like VIRTUAL, ai16z showing massive gains. Early stage with high growth potential.'
      },
      {
        name: 'Meme_Coins',
        market_heat: 9.8,
        sustainability: 3.9,
        competition_level: 'high',
        lifecycle_stage: 'evergreen',
        lifecycle_multiplier: 1.0,
        keywords: ['meme', 'pepe', 'doge', 'shib', 'wojak', 'frog', 'dog', 'cat', 'bonk', 'wif', 'popcat', 'goat', 'pnut', 'degen'],
        ai_reasoning: 'Meme coins remain the highest traffic category (25% of CoinGecko). Low sustainability but consistently attracts retail attention.'
      },
      {
        name: 'DeSci',
        market_heat: 8.5,
        sustainability: 8.0,
        competition_level: 'low',
        lifecycle_stage: 'early_growth',
        lifecycle_multiplier: 1.2,
        keywords: ['desci', 'science', 'research', 'biotech', 'longevity', 'health', 'medicine', 'bio', 'vita'],
        ai_reasoning: 'DeSci emerging as major narrative. RIF, VITA showing strength. Real utility in funding research, backed by serious institutions.'
      },
      {
        name: 'RWA',
        market_heat: 7.9,
        sustainability: 9.1,
        competition_level: 'medium',
        lifecycle_stage: 'mature_growth',
        lifecycle_multiplier: 1.1,
        keywords: ['rwa', 'real world asset', 'tokenized', 'tokenization', 'property', 'real estate', 'treasury', 'bond', 'blackrock', 'ondo'],
        ai_reasoning: 'RWA has strong institutional backing (BlackRock $589M fund). High sustainability due to real asset backing. Mature but still growing.'
      },
      {
        name: 'DeFi',
        market_heat: 6.8,
        sustainability: 8.2,
        competition_level: 'high',
        lifecycle_stage: 'mature',
        lifecycle_multiplier: 0.9,
        keywords: ['defi', 'decentralized finance', 'yield', 'farming', 'liquidity', 'amm', 'dex', 'swap', 'lending', 'staking'],
        ai_reasoning: 'DeFi is core infrastructure, proven utility. Mature market with established players. Growth is moderate but stable.'
      },
      {
        name: 'Gaming_Metaverse',
        market_heat: 1.8,
        sustainability: 2.5,
        competition_level: 'medium',
        lifecycle_stage: 'decline',
        lifecycle_multiplier: 0.4,
        keywords: ['gaming', 'game', 'metaverse', 'play to earn', 'p2e', 'nft game', 'gamefi', 'virtual world'],
        ai_reasoning: 'Gaming/Metaverse narrative has collapsed. -93% funding decline per Messari. Avoid this narrative - negative signal.'
      },
      {
        name: 'Layer2_Scaling',
        market_heat: 5.9,
        sustainability: 8.5,
        competition_level: 'high',
        lifecycle_stage: 'mature',
        lifecycle_multiplier: 0.9,
        keywords: ['layer 2', 'l2', 'rollup', 'optimistic', 'zk', 'zero knowledge', 'scaling', 'arbitrum', 'optimism', 'base'],
        ai_reasoning: 'L2s are critical infrastructure but market is saturated (50+ L2s). Difficult for new projects to stand out.'
      },
      {
        name: 'Pump_Fun_Meta',
        market_heat: 8.0,
        sustainability: 4.0,
        competition_level: 'high',
        lifecycle_stage: 'peak',
        lifecycle_multiplier: 1.0,
        keywords: ['pump', 'pumpfun', 'bonding curve', 'fair launch', 'no presale', 'stealth', 'organic'],
        ai_reasoning: 'Pump.fun has dominated Solana meme coin launches. High activity but many rugs. Peak attention, may decline soon.'
      },
      {
        name: 'Celebrity_KOL',
        market_heat: 7.0,
        sustainability: 3.0,
        competition_level: 'medium',
        lifecycle_stage: 'growth',
        lifecycle_multiplier: 1.1,
        keywords: ['celebrity', 'influencer', 'ansem', 'murad', 'hsaka', 'kol', 'paid', 'call', 'alpha'],
        ai_reasoning: 'KOL-backed tokens can pump hard but often dump after. High risk, high reward. Watch for rug pulls.'
      },
      {
        name: 'Christmas_Seasonal',
        market_heat: 6.5,
        sustainability: 1.0,
        competition_level: 'low',
        lifecycle_stage: 'peak',
        lifecycle_multiplier: 0.8,
        keywords: ['christmas', 'santa', 'xmas', 'holiday', 'new year', 'winter', 'gift', 'noel'],
        ai_reasoning: 'Seasonal narrative. Will peak around Dec 25 then crash. Very short window, trade carefully.'
      }
    ];

    const insertStmt = this.db.prepare(`
      INSERT INTO ai_narratives (
        narrative_name, market_heat, sustainability, competition_level,
        lifecycle_stage, lifecycle_multiplier, keywords, ai_reasoning,
        weight, last_updated, update_source
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'initial')
    `);

    for (const narrative of initialNarratives) {
      // Calculate weight: (heat * 0.4 + sustainability * 0.3 + (10 - competition) * 0.2 + historical * 0.1) * lifecycle
      const competitionScore = narrative.competition_level === 'low' ? 8 : 
                               narrative.competition_level === 'medium' ? 5 : 2;
      const weight = (
        narrative.market_heat * 0.4 +
        narrative.sustainability * 0.3 +
        competitionScore * 0.2 +
        5 * 0.1  // Default historical score
      ) * narrative.lifecycle_multiplier;

      insertStmt.run(
        narrative.name,
        narrative.market_heat,
        narrative.sustainability,
        narrative.competition_level,
        narrative.lifecycle_stage,
        narrative.lifecycle_multiplier,
        JSON.stringify(narrative.keywords),
        narrative.ai_reasoning,
        Math.min(10, weight),
        Date.now()
      );
    }

    console.log(`✅ [AI Narrative] Seeded ${initialNarratives.length} initial narratives`);
  }

  /**
   * Load narratives into memory cache
   */
  loadNarrativesCache() {
    const narratives = this.db.prepare('SELECT * FROM ai_narratives ORDER BY weight DESC').all();
    
    this.narrativesCache.clear();
    for (const n of narratives) {
      this.narrativesCache.set(n.narrative_name, {
        ...n,
        keywords: JSON.parse(n.keywords || '[]')
      });
    }
    
    console.log(`📚 [AI Narrative] Loaded ${narratives.length} narratives into cache`);
  }

  /**
   * Weekly AI Update - Ask Grok to reassess all narratives
   * 
   * This should be called by a cron job weekly
   */
  async weeklyNarrativeUpdate() {
    console.log('🔄 [AI Narrative] Starting weekly narrative update...');
    
    const prompt = `You are a crypto market analyst. Analyze the current narrative landscape in crypto for December 2024.

For each of these narratives, provide updated metrics:
1. AI_Agents
2. Meme_Coins
3. DeSci
4. RWA
5. DeFi
6. Gaming_Metaverse
7. Layer2_Scaling
8. Pump_Fun_Meta
9. Celebrity_KOL

Also identify any NEW hot narratives that should be added.

For each narrative, rate:
- market_heat (0-10): Current market attention and trading volume
- sustainability (0-10): Long-term viability and real utility
- lifecycle_stage: early_explosion / early_growth / growth / peak / mature / decline
- competition_level: low / medium / high
- brief reasoning (1-2 sentences)

Respond in JSON format:
{
  "narratives": [
    {
      "name": "AI_Agents",
      "market_heat": 9.5,
      "sustainability": 7.5,
      "lifecycle_stage": "early_explosion",
      "competition_level": "medium",
      "reasoning": "..."
    }
  ],
  "new_narratives": [
    {
      "name": "...",
      "keywords": ["...", "..."],
      ...
    }
  ]
}`;

    try {
      const response = await this.grokClient.askGrok(prompt);
      
      // Parse response
      const jsonMatch = response.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        console.error('❌ [AI Narrative] Failed to parse Grok response');
        return;
      }
      
      const data = JSON.parse(jsonMatch[0]);
      
      // Update existing narratives
      const updateStmt = this.db.prepare(`
        UPDATE ai_narratives SET
          market_heat = ?,
          sustainability = ?,
          lifecycle_stage = ?,
          lifecycle_multiplier = ?,
          competition_level = ?,
          ai_reasoning = ?,
          weight = ?,
          last_updated = ?,
          update_source = 'weekly_ai'
        WHERE narrative_name = ?
      `);

      for (const n of data.narratives || []) {
        const lifecycleMultiplier = this.getLifecycleMultiplier(n.lifecycle_stage);
        const competitionScore = n.competition_level === 'low' ? 8 : 
                                 n.competition_level === 'medium' ? 5 : 2;
        const weight = (
          n.market_heat * 0.4 +
          n.sustainability * 0.3 +
          competitionScore * 0.2 +
          5 * 0.1
        ) * lifecycleMultiplier;

        updateStmt.run(
          n.market_heat,
          n.sustainability,
          n.lifecycle_stage,
          lifecycleMultiplier,
          n.competition_level,
          n.reasoning,
          Math.min(10, weight),
          Date.now(),
          n.name
        );
      }

      // Add new narratives
      if (data.new_narratives && data.new_narratives.length > 0) {
        const insertStmt = this.db.prepare(`
          INSERT OR IGNORE INTO ai_narratives (
            narrative_name, market_heat, sustainability, competition_level,
            lifecycle_stage, lifecycle_multiplier, keywords, ai_reasoning,
            weight, last_updated, update_source
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'weekly_ai')
        `);

        for (const n of data.new_narratives) {
          const lifecycleMultiplier = this.getLifecycleMultiplier(n.lifecycle_stage);
          const competitionScore = n.competition_level === 'low' ? 8 : 
                                   n.competition_level === 'medium' ? 5 : 2;
          const weight = (
            n.market_heat * 0.4 +
            n.sustainability * 0.3 +
            competitionScore * 0.2 +
            5 * 0.1
          ) * lifecycleMultiplier;

          insertStmt.run(
            n.name,
            n.market_heat,
            n.sustainability,
            n.competition_level,
            n.lifecycle_stage,
            lifecycleMultiplier,
            JSON.stringify(n.keywords || []),
            n.reasoning,
            Math.min(10, weight),
            Date.now()
          );
        }
      }

      // Reload cache
      this.loadNarrativesCache();
      
      console.log(`✅ [AI Narrative] Weekly update complete. Updated ${data.narratives?.length || 0} narratives, added ${data.new_narratives?.length || 0} new`);
      
    } catch (error) {
      console.error('❌ [AI Narrative] Weekly update failed:', error.message);
    }
  }

  /**
   * Real-time: Ask Grok to identify a token's narrative
   * 
   * @param {string} tokenSymbol - Token symbol
   * @param {string} tokenName - Token name
   * @param {Object} twitterData - Twitter data from Grok search
   * @returns {Object} { narrative, confidence, reasoning }
   */
  async identifyTokenNarrative(tokenSymbol, tokenName, twitterData = null) {
    // First, try keyword matching (fast path)
    const keywordMatch = this.matchNarrativeByKeywords(tokenSymbol, tokenName);
    if (keywordMatch && keywordMatch.confidence >= 0.7) {
      return keywordMatch;
    }

    // If no strong keyword match, ask Grok (slow path)
    const twitterContext = twitterData ? 
      `Twitter mentions: ${twitterData.mention_count}, sentiment: ${twitterData.sentiment}` : 
      'No Twitter data available';

    const prompt = `Identify the narrative category for this crypto token:
Symbol: ${tokenSymbol}
Name: ${tokenName || 'Unknown'}
${twitterContext}

Available narratives: ${Array.from(this.narrativesCache.keys()).join(', ')}

If it doesn't fit any existing narrative, respond with "Unknown".

Respond in JSON:
{
  "narrative": "Meme_Coins",
  "confidence": 0.85,
  "reasoning": "Token name suggests meme culture theme"
}`;

    try {
      const response = await this.grokClient.askGrok(prompt);
      const jsonMatch = response.match(/\{[\s\S]*?\}/);
      
      if (jsonMatch) {
        const result = JSON.parse(jsonMatch[0]);
        return {
          narrative: result.narrative,
          confidence: result.confidence || 0.5,
          reasoning: result.reasoning || 'AI identified',
          source: 'grok_ai'
        };
      }
    } catch (error) {
      console.log(`   ⚠️ Grok narrative identification failed: ${error.message}`);
    }

    // Fallback to keyword match or unknown
    return keywordMatch || {
      narrative: 'Unknown',
      confidence: 0,
      reasoning: 'Could not identify narrative',
      source: 'fallback'
    };
  }

  /**
   * Match narrative by keywords (fast local matching)
   */
  matchNarrativeByKeywords(tokenSymbol, tokenName) {
    const searchText = `${tokenSymbol} ${tokenName || ''}`.toLowerCase();
    
    let bestMatch = null;
    let bestScore = 0;

    for (const [name, narrative] of this.narrativesCache) {
      const keywords = narrative.keywords || [];
      let matchCount = 0;
      const matchedKeywords = [];

      for (const keyword of keywords) {
        if (searchText.includes(keyword.toLowerCase())) {
          matchCount++;
          matchedKeywords.push(keyword);
        }
      }

      if (matchCount > 0) {
        // Score based on match density and narrative weight
        const matchDensity = matchCount / keywords.length;
        const score = matchDensity * narrative.weight;

        if (score > bestScore) {
          bestScore = score;
          bestMatch = {
            narrative: name,
            confidence: Math.min(1.0, 0.5 + matchDensity * 0.5),
            reasoning: `Matched keywords: ${matchedKeywords.join(', ')}`,
            matchedKeywords,
            source: 'keyword_match'
          };
        }
      }
    }

    return bestMatch;
  }

  /**
   * Get narrative score for a token
   * 
   * @param {string} tokenSymbol 
   * @param {string} tokenName 
   * @param {Object} twitterData 
   * @returns {Object} { score, narrative, breakdown }
   */
  async scoreNarrative(tokenSymbol, tokenName, twitterData = null) {
    // Identify narrative
    const identification = await this.identifyTokenNarrative(tokenSymbol, tokenName, twitterData);
    
    if (!identification || identification.narrative === 'Unknown') {
      // No narrative identified - give base score for pump.fun tokens
      const isPumpFun = tokenSymbol?.toLowerCase().includes('pump') || 
                        tokenName?.toLowerCase().includes('pump');
      return {
        score: isPumpFun ? 5 : 2,
        narrative: null,
        breakdown: {
          identified_narrative: 'Unknown',
          confidence: 0,
          reasoning: 'No narrative match found',
          is_pump_fun: isPumpFun
        }
      };
    }

    // Get narrative metrics from database
    const narrative = this.narrativesCache.get(identification.narrative);
    
    if (!narrative) {
      return {
        score: 3,
        narrative: identification.narrative,
        breakdown: {
          identified_narrative: identification.narrative,
          confidence: identification.confidence,
          reasoning: 'Narrative not in database',
          source: identification.source
        }
      };
    }

    // Calculate score (0-25 points for Narrative component)
    // Formula: (weight / 10) * 20 * confidence * twitter_bonus
    let score = (narrative.weight / 10) * 20 * identification.confidence;

    // Twitter validation bonus
    let twitterBonus = 1.0;
    if (twitterData && twitterData.mention_count >= 10) {
      twitterBonus = 1.2;  // 20% bonus
      score *= twitterBonus;
    }

    // Cap at 25
    score = Math.min(25, Math.round(score));

    return {
      score,
      narrative: identification.narrative,
      breakdown: {
        identified_narrative: identification.narrative,
        narrative_weight: narrative.weight,
        market_heat: narrative.market_heat,
        lifecycle_stage: narrative.lifecycle_stage,
        sustainability: narrative.sustainability,
        confidence: identification.confidence,
        twitter_bonus: twitterBonus,
        reasoning: identification.reasoning,
        ai_reasoning: narrative.ai_reasoning,
        source: identification.source
      }
    };
  }

  /**
   * Get lifecycle multiplier based on stage
   */
  getLifecycleMultiplier(stage) {
    const multipliers = {
      'early_explosion': 1.3,
      'early_growth': 1.2,
      'growth': 1.1,
      'peak': 1.0,
      'mature': 0.9,
      'decline': 0.5,
      'evergreen': 1.0,
      'unknown': 0.8
    };
    return multipliers[stage] || 0.8;
  }

  /**
   * Get all narratives ranked by weight
   */
  getRankedNarratives() {
    return Array.from(this.narrativesCache.values())
      .sort((a, b) => b.weight - a.weight)
      .map(n => ({
        name: n.narrative_name,
        weight: n.weight,
        market_heat: n.market_heat,
        lifecycle_stage: n.lifecycle_stage,
        sustainability: n.sustainability,
        last_updated: new Date(n.last_updated).toISOString()
      }));
  }

  /**
   * Manually add/update a narrative
   */
  addOrUpdateNarrative(narrativeData) {
    const lifecycleMultiplier = this.getLifecycleMultiplier(narrativeData.lifecycle_stage);
    const competitionScore = narrativeData.competition_level === 'low' ? 8 : 
                             narrativeData.competition_level === 'medium' ? 5 : 2;
    const weight = (
      narrativeData.market_heat * 0.4 +
      narrativeData.sustainability * 0.3 +
      competitionScore * 0.2 +
      5 * 0.1
    ) * lifecycleMultiplier;

    this.db.prepare(`
      INSERT OR REPLACE INTO ai_narratives (
        narrative_name, market_heat, sustainability, competition_level,
        lifecycle_stage, lifecycle_multiplier, keywords, ai_reasoning,
        weight, last_updated, update_source
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'manual')
    `).run(
      narrativeData.name,
      narrativeData.market_heat,
      narrativeData.sustainability,
      narrativeData.competition_level,
      narrativeData.lifecycle_stage,
      lifecycleMultiplier,
      JSON.stringify(narrativeData.keywords || []),
      narrativeData.reasoning || '',
      Math.min(10, weight),
      Date.now()
    );

    // Reload cache
    this.loadNarrativesCache();
  }
}

export default AINarrativeSystem;
