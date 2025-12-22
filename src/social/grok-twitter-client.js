/**
 * Grok API Twitter Client
 *
 * Uses xAI Grok API to search Twitter/X for token mentions
 * Provides Twitter social data for Soft Score calculations
 */

import https from 'https';

class GrokTwitterClient {
  constructor(apiKey) {
    this.apiKey = apiKey || process.env.XAI_API_KEY;
    this.baseURL = 'https://api.x.ai/v1';
    this.model = 'grok-4-1-fast';

    if (!this.apiKey) {
      console.warn('⚠️  XAI_API_KEY not found - Grok Twitter client will not work');
    }
  }

  /**
   * Search Twitter for token mentions
   *
   * @param {string} tokenSymbol - Token symbol (e.g., 'BONK')
   * @param {string} tokenCA - Token contract address
   * @param {number} timeframeMinutes - Search timeframe in minutes (default: 15)
   * @returns {Promise<Object>} Twitter data
   */
  async searchToken(tokenSymbol, tokenCA, timeframeMinutes = 15) {
    if (!this.apiKey) {
      throw new Error('XAI_API_KEY not configured');
    }

    // 取代币地址的前8位和后6位用于搜索
    const caShort = tokenCA ? `${tokenCA.slice(0, 8)}...${tokenCA.slice(-6)}` : '';
    const caPrefix = tokenCA ? tokenCA.slice(0, 10) : '';

    const prompt = `
Search Twitter/X for this SPECIFIC crypto token:
- Symbol: $${tokenSymbol}
- Contract Address: ${tokenCA || 'unknown'}
- Chain: ${tokenCA?.startsWith('0x') ? 'BSC/ETH' : 'Solana'}

IMPORTANT VERIFICATION RULES:
1. There may be MULTIPLE tokens with symbol "$${tokenSymbol}" - verify by contract address
2. Look for tweets mentioning address prefix: ${caPrefix}
3. Only count tweets from the LAST ${timeframeMinutes} minutes

CRITICAL - SIGNAL ORIGIN ANALYSIS:
For each tweet, determine:
- Is the author the ORIGINAL source, or just QUOTING/MENTIONING someone else?
- If tweet says "@bigKOL bought this" but @bigKOL didn't actually tweet it - that's FAKE
- Check if KOLs ACTUALLY posted about this token themselves (not just being mentioned)

AUTHENTICITY CHECKS:
- Real KOL signal: KOL's own account posted about the token
- Fake/borrowed hype: Random accounts claiming "KOL bought this" without proof
- Bot activity: Many similar tweets from low-follower accounts at same time
- Organic spread: Different users discovering and sharing naturally

Return JSON:
{
  "mention_count": <tweets about THIS token with matching address>,
  "unique_authors": <different accounts>,
  "engagement": {
    "total_likes": <sum of likes>,
    "total_retweets": <sum of retweets>,
    "total_views": <sum of views if available>,
    "avg_engagement_per_tweet": <average>
  },
  "sentiment": "positive/neutral/negative",
  
  "origin_source": {
    "type": "kol_original/kol_mentioned_fake/bot_swarm/organic/unknown",
    "first_tweet": {
      "author": "@username",
      "followers": <count>,
      "verified": true/false,
      "tweet_text": "actual tweet content",
      "posted_time": "X minutes ago",
      "engagement": {"likes": X, "retweets": X, "views": X}
    },
    "is_authentic": true/false,
    "explanation": "<why you think this is authentic or fake>"
  },
  
  "kol_involvement": {
    "kols_who_actually_posted": [
      {"username": "@xxx", "followers": X, "tweet_engagement": X}
    ],
    "kols_just_mentioned_by_others": ["@yyy", "@zzz"],
    "real_kol_count": <KOLs who actually posted>,
    "fake_kol_mentions": <times KOLs mentioned but didn't post>
  },
  
  "bot_detection": {
    "suspected_bot_tweets": <count of likely bot tweets>,
    "bot_indicators": ["similar text", "low followers", "same timestamp", etc],
    "organic_tweet_ratio": <0.0-1.0, higher = more organic>
  },
  
  "spread_pattern": {
    "pattern": "kol_driven/bot_driven/organic_viral/pump_group",
    "velocity": "slow/medium/fast/explosive",
    "geographic_spread": "single_region/multi_region/global"
  },
  
  "narrative_score": {
    "total": <0-100, overall narrative strength>,
    "breakdown": {
      "authenticity": <0-25, is the hype real or fake?>,
      "kol_power": <0-25, real KOL involvement and their influence>,
      "viral_potential": <0-25, organic spread and engagement quality>,
      "timing": <0-25, is this early alpha or late fomo?>
    },
    "grade": "S/A/B/C/D/F",
    "recommendation": "strong_buy/buy/hold/avoid/run",
    "reasoning": "<1-2 sentence explanation of the score>"
  },
  
  "verified_token": true/false,
  "confidence": "high/medium/low",
  "risk_flags": ["list of concerns if any"],
  
  "top_tweets": [
    {
      "text": "tweet content",
      "author": "@username",
      "followers": <count>,
      "engagement": {"likes": X, "retweets": X},
      "is_original_source": true/false,
      "is_bot_suspected": true/false
    }
  ]
}

If no tweets found matching the contract address:
{
  "mention_count": 0,
  "verified_token": false,
  "confidence": "low",
  "reason": "No tweets found matching contract address"
}

Return ONLY the JSON.
`;

    try {
      const result = await this._callGrokAPI(prompt);

      // Parse JSON from response
      let data;
      try {
        let content = result.choices[0].message.content;

        // 🛠️ Enhanced JSON extraction logic - handles various response formats
        // Try method 1: Extract from ```json code block
        const jsonBlockMatch = content.match(/```json\n([\s\S]*?)\n```/);
        if (jsonBlockMatch) {
          content = jsonBlockMatch[1];
        } else {
          // Try method 2: Extract from ``` code block
          const codeBlockMatch = content.match(/```\n([\s\S]*?)\n```/);
          if (codeBlockMatch) {
            content = codeBlockMatch[1];
          } else {
            // Try method 3: Extract first { to last } (find JSON object)
            const jsonMatch = content.match(/\{[\s\S]*\}/);
            if (jsonMatch) {
              content = jsonMatch[0];
            }
          }
        }

        // Try to parse
        data = JSON.parse(content);

      } catch (parseError) {
        console.warn(`⚠️  Grok response parsing failed. Using default values.`);
        console.warn(`   Error: ${parseError.message}`);
        console.warn(`   Content sample: ${result.choices[0].message.content.substring(0, 100)}...`);

        // 🛡️ Fallback: return safe empty object to prevent system crash
        data = {
          mention_count: 0,
          unique_authors: 0,
          engagement: 0,
          sentiment: 'neutral',
          kol_count: 0,
          top_tweets: []
        };
      }

      // Add metadata
      data.source = 'grok_api';
      data.token_symbol = tokenSymbol;
      data.token_ca = tokenCA;
      data.timeframe_minutes = timeframeMinutes;
      data.timestamp = new Date().toISOString();

      // Token usage for cost tracking
      data.tokens_used = result.usage ? result.usage.total_tokens : 0;

      console.log(`✅ Grok Twitter search: $${tokenSymbol} - ${data.mention_count} mentions, ${data.engagement?.total_likes || 0} engagement`);

      return data;

    } catch (error) {
      console.error(`❌ Grok Twitter search failed for $${tokenSymbol}:`, error.message);
      throw error;
    }
  }

  /**
   * Call Grok API
   *
   * @private
   * @param {string} userPrompt - User prompt
   * @returns {Promise<Object>} API response
   */
  _callGrokAPI(userPrompt) {
    return new Promise((resolve, reject) => {
      const requestData = JSON.stringify({
        model: this.model,
        messages: [
          {
            role: 'system',
            content: 'You are a Twitter data analyst with access to Twitter/X data. Search for recent tweets and analyze them. Always return valid JSON only, no other text.'
          },
          {
            role: 'user',
            content: userPrompt
          }
        ],
        temperature: 0.3,
        max_tokens: 2000
      });

      const options = {
        hostname: 'api.x.ai',
        port: 443,
        path: '/v1/chat/completions',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(requestData),
          'Authorization': `Bearer ${this.apiKey}`
        }
      };

      const req = https.request(options, (res) => {
        let data = '';

        res.on('data', (chunk) => {
          data += chunk;
        });

        res.on('end', () => {
          if (res.statusCode !== 200) {
            reject(new Error(`Grok API error: ${res.statusCode} - ${data}`));
            return;
          }

          try {
            const result = JSON.parse(data);
            resolve(result);
          } catch (parseError) {
            reject(new Error(`Failed to parse Grok API response: ${parseError.message}`));
          }
        });
      });

      req.on('error', (error) => {
        reject(new Error(`Grok API request failed: ${error.message}`));
      });

      req.write(requestData);
      req.end();
    });
  }

  /**
   * Validate Telegram signal against Twitter activity
   *
   * @param {string} tokenSymbol - Token symbol
   * @param {string} tokenCA - Token contract address
   * @param {Date} tgMentionTime - Time of Telegram mention
   * @returns {Promise<Object>} Validation result with credibility score
   */
  async validateSignal(tokenSymbol, tokenCA, tgMentionTime) {
    try {
      // Search Twitter for the token
      const twitterData = await this.searchToken(tokenSymbol, tokenCA, 15);

      // Calculate credibility score (0-100)
      let credibilityScore = 0;
      const reasons = [];

      // Twitter activity (max 40 points)
      if (twitterData.mention_count >= 20) {
        credibilityScore += 40;
        reasons.push(`High Twitter activity (${twitterData.mention_count} mentions)`);
      } else if (twitterData.mention_count >= 10) {
        credibilityScore += 25;
        reasons.push(`Moderate Twitter activity (${twitterData.mention_count} mentions)`);
      } else if (twitterData.mention_count >= 5) {
        credibilityScore += 15;
        reasons.push(`Some Twitter activity (${twitterData.mention_count} mentions)`);
      }

      // KOL mentions (max 30 points)
      if (twitterData.kol_count >= 3) {
        credibilityScore += 30;
        reasons.push(`Multiple KOL mentions (${twitterData.kol_count} KOLs)`);
      } else if (twitterData.kol_count >= 1) {
        credibilityScore += 20;
        reasons.push(`KOL mentioned (${twitterData.kol_count} KOL)`);
      }

      // Engagement (max 20 points)
      if (twitterData.engagement >= 1000) {
        credibilityScore += 20;
        reasons.push(`High engagement (${twitterData.engagement})`);
      } else if (twitterData.engagement >= 500) {
        credibilityScore += 15;
        reasons.push(`Good engagement (${twitterData.engagement})`);
      }

      // Sentiment (max 10 points)
      if (twitterData.sentiment === 'positive') {
        credibilityScore += 10;
        reasons.push('Positive sentiment');
      } else if (twitterData.sentiment === 'neutral') {
        credibilityScore += 5;
        reasons.push('Neutral sentiment');
      }

      const verified = credibilityScore >= 50;

      return {
        credibility_score: Math.min(credibilityScore, 100),
        verified,
        reasons,
        twitter_data: twitterData
      };

    } catch (error) {
      console.error('Grok signal validation failed:', error.message);
      return {
        credibility_score: 0,
        verified: false,
        reasons: [`Grok API error: ${error.message}`],
        twitter_data: null
      };
    }
  }

  /**
   * Generic Grok chat - for narrative analysis and other queries
   *
   * @param {string} prompt - The prompt to send to Grok
   * @returns {Promise<string>} Grok's response text
   */
  async askGrok(prompt) {
    if (!this.apiKey) {
      throw new Error('XAI_API_KEY not configured');
    }

    const requestBody = JSON.stringify({
      model: this.model,
      messages: [
        {
          role: 'system',
          content: 'You are a crypto market analyst assistant. Provide concise, data-driven analysis. Always respond in valid JSON when requested.'
        },
        {
          role: 'user',
          content: prompt
        }
      ],
      temperature: 0.3,
      max_tokens: 2000
    });

    const options = {
      hostname: 'api.x.ai',
      port: 443,
      path: '/v1/chat/completions',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`,
        'Content-Length': Buffer.byteLength(requestBody)
      }
    };

    return new Promise((resolve, reject) => {
      const req = https.request(options, (res) => {
        let data = '';

        res.on('data', (chunk) => {
          data += chunk;
        });

        res.on('end', () => {
          try {
            if (res.statusCode !== 200) {
              reject(new Error(`Grok API error: ${res.statusCode} - ${data}`));
              return;
            }

            const parsed = JSON.parse(data);
            const content = parsed.choices?.[0]?.message?.content;

            if (!content) {
              reject(new Error('No content in Grok response'));
              return;
            }

            resolve(content);
          } catch (error) {
            reject(new Error(`Failed to parse Grok response: ${error.message}`));
          }
        });
      });

      req.on('error', (error) => {
        reject(new Error(`Grok request failed: ${error.message}`));
      });

      req.write(requestBody);
      req.end();
    });
  }
}

export default GrokTwitterClient;
