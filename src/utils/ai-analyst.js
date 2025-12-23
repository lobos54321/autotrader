/**
 * AI Analyst Module
 * 
 * 使用 LLM (Grok/OpenAI) 对 DeBot 数据进行二次分析
 * 
 * 核心职责:
 * 1. 叙事质量判断 - DeBot 给分数，我们判断"为什么"
 * 2. 风险识别 - 识别烂梗、老项目换皮、诈骗特征
 * 3. 输出调节分 - 用于调整最终评分 (±5分)
 * 
 * 使用 Grok API (XAI) - 更懂 Meme 文化
 */

import OpenAI from 'openai';
import { generateNarrativePrompt } from '../prompts/narrative-analyst.js';

class AIAnalyst {
    constructor() {
        this.client = null;
        this.enabled = process.env.AI_ANALYSIS_ENABLED === 'true';
        this.timeoutMs = parseInt(process.env.AI_TIMEOUT_MS || '3000', 10);
        
        // 初始化客户端 (优先 Grok，其次 OpenAI)
        if (this.enabled) {
            if (process.env.XAI_API_KEY) {
                this.client = new OpenAI({
                    apiKey: process.env.XAI_API_KEY,
                    baseURL: 'https://api.x.ai/v1'
                });
                this.model = 'grok-4-1-fast-reasoning';  // Grok 4.1 Fast with reasoning
                console.log('[AI Analyst] ✅ 使用 Grok 4.1 Fast Reasoning (XAI) API');
            } else if (process.env.OPENAI_API_KEY) {
                this.client = new OpenAI({
                    apiKey: process.env.OPENAI_API_KEY
                });
                this.model = 'gpt-4o-mini';
                console.log('[AI Analyst] ✅ 使用 OpenAI API');
            } else {
                console.warn('[AI Analyst] ⚠️ 未配置 AI API Key，AI 分析已禁用');
                this.enabled = false;
            }
        } else {
            console.log('[AI Analyst] AI 分析已禁用 (AI_ANALYSIS_ENABLED=false)');
        }
    }
    
    /**
     * 分析代币叙事质量
     * 
     * @param {Object} data - 包含 token, aiReport, heatmap 的综合数据
     * @returns {Object} { score: 0-100, reason: string, risk_level: string }
     */
    async evaluate(data) {
        if (!this.enabled || !this.client) {
            return null; // 返回 null 表示跳过 AI 分析
        }
        
        const symbol = data.symbol || data.tokenAddress?.slice(0, 8) || 'Unknown';
        console.log(`🧠 [AI] 分析中: ${symbol}...`);
        
        try {
            // 3秒超时保护
            const result = await Promise.race([
                this.callLLM(data),
                this.timeout(this.timeoutMs)
            ]);
            
            // 验证返回格式
            if (!this.isValidResult(result)) {
                console.warn(`⚠️ [AI] 返回格式异常，使用默认值`);
                return this.getDefaultResult();
            }
            
            console.log(`💡 [AI] ${symbol}: ${result.score}分 | ${result.reason} (${result.risk_level})`);
            return result;
            
        } catch (error) {
            if (error.message === 'AI_TIMEOUT') {
                console.warn(`⚠️ [AI] 超时 (${this.timeoutMs}ms)，跳过分析`);
            } else {
                console.error(`❌ [AI] 分析失败: ${error.message}`);
            }
            return this.getDefaultResult();
        }
    }
    
    /**
     * 调用 LLM API
     */
    async callLLM(data) {
        const prompt = generateNarrativePrompt(data);
        
        const completion = await this.client.chat.completions.create({
            model: this.model,
            messages: [
                {
                    role: 'system',
                    content: '你是一个加密货币 Meme 币分析专家，只返回 JSON 格式的分析结果。'
                },
                {
                    role: 'user',
                    content: prompt
                }
            ],
            temperature: 0.3,  // 低温度 = 稳定输出
            max_tokens: 200
        });
        
        const content = completion.choices[0]?.message?.content || '';
        
        // 尝试解析 JSON
        try {
            // 处理可能的 markdown 代码块
            const jsonStr = content.replace(/```json\n?|\n?```/g, '').trim();
            return JSON.parse(jsonStr);
        } catch (e) {
            console.warn(`⚠️ [AI] JSON 解析失败: ${content.slice(0, 100)}`);
            throw new Error('JSON_PARSE_ERROR');
        }
    }
    
    /**
     * 超时 Promise
     */
    timeout(ms) {
        return new Promise((_, reject) => {
            setTimeout(() => reject(new Error('AI_TIMEOUT')), ms);
        });
    }
    
    /**
     * 验证结果格式
     */
    isValidResult(result) {
        return result &&
            typeof result.score === 'number' &&
            result.score >= 0 &&
            result.score <= 100 &&
            typeof result.reason === 'string' &&
            ['LOW', 'MEDIUM', 'HIGH'].includes(result.risk_level);
    }
    
    /**
     * 默认结果 (AI 失败时使用)
     */
    getDefaultResult() {
        return {
            score: 50,
            reason: 'AI离线，使用默认分',
            risk_level: 'MEDIUM'
        };
    }
    
    /**
     * 准备分析数据
     * 从 token, aiReport, tgHeat 提取所需字段
     */
    prepareData(token, aiReport, tgHeat) {
        return {
            // 基础信息
            symbol: token.symbol || token.tokenAddress?.slice(0, 8),
            tokenAddress: token.tokenAddress,
            
            // 链上数据
            smartWalletOnline: token.smartWalletOnline || 0,
            liquidity: token.liquidity || 0,
            signalCount: token.signalCount || 0,
            tokenLevel: token.tokenLevel || token.tokenTier,
            maxPriceGain: token.maxPriceGain || 0,
            
            // DeBot AI Report
            debotScore: aiReport?.rating?.score || 0,
            narrativeType: aiReport?.narrativeType || aiReport?.narrative_type,
            narrative: aiReport?.origin || aiReport?.background?.origin?.text || '',
            negativeIncidents: aiReport?.distribution?.negativeIncidents || 
                              aiReport?.distribution?.negative_incidents?.text || '',
            
            // TG 热度
            tgChannelCount: tgHeat?.channelCount || 0,
            hasTier1: (tgHeat?.tier1Count || 0) > 0
        };
    }
}

// 单例导出
const aiAnalyst = new AIAnalyst();

export default aiAnalyst;
export { AIAnalyst };
