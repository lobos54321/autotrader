/**
 * Solana Chain Snapshot Module
 *
 * Responsibilities:
 * - Freeze/Mint Authority检查
 * - LP状态验证 (Burned/Locked)
 * - 流动性获取
 * - Top10持仓分析（剔除池子/曲线/交易所）
 * - 滑点测试（按仓位大小）
 * - Wash Trading检测
 * - Key Risk Wallets识别
 */

import { Connection, PublicKey } from '@solana/web3.js';
import axios from 'axios';
import RateLimiter from '../utils/rate-limiter.js';

export class SolanaSnapshotService {
  constructor(config) {
    this.config = config;

    // Use Alchemy RPC if API key is available
    const alchemyKey = process.env.ALCHEMY_API_KEY;
    const rpcUrl = alchemyKey
      ? `https://solana-mainnet.g.alchemy.com/v2/${alchemyKey}`
      : (process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com');

    this.connection = new Connection(rpcUrl);
    this.alchemyApiKey = alchemyKey;

    // Helius API configuration
    this.heliusApiKey = process.env.HELIUS_API_KEY || '';
    this.heliusApiUrl = 'https://api.helius.xyz/v0';

    // ⚙️ Initialize Rate Limiter
    // Alchemy free tier: ~25 RPS (requests per second)
    // We set conservatively: 10 RPS with burst capacity of 5
    this.rateLimiter = new RateLimiter(10, 5);

    // Known addresses to exclude from Top10 calculation
    this.excludedAddresses = new Set([
      // Raydium Program IDs
      '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8',  // Raydium AMM
      '5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1',  // Raydium V4
      // Common burn addresses
      '1nc1nerator11111111111111111111111111111111',
      '11111111111111111111111111111111',
      // DEX curve addresses (add more as needed)
    ]);

    console.log(`📡 [SOL] Using RPC: ${alchemyKey ? 'Alchemy (Enhanced)' : 'Public RPC'}`);
  }

  /**
   * Main entry: Get complete snapshot for a SOL token
   */
  async getSnapshot(tokenCA, plannedPosition = null) {
    console.log(`📸 [SOL] Getting snapshot for ${tokenCA}`);

    try {
      const [
        mintInfo,
        lpStatus,
        liquidity,
        top10Data,
        slippageData,
        washData,
        riskWallets,
        priceData
      ] = await Promise.allSettled([
        this.getMintAuthorities(tokenCA),
        this.getLPStatus(tokenCA),
        this.getLiquidity(tokenCA),
        // 🚨 TEMPORARILY DISABLED: Top10 analysis consumes too many CU (causes 429 errors)
        // Re-enable after implementing rate limiter
        Promise.resolve({ top10_percent: null, holder_count: null }),  // this.getTop10Analysis(tokenCA),
        plannedPosition ? this.testSlippage(tokenCA, plannedPosition) : Promise.resolve(null),
        this.detectWashTrading(tokenCA),
        this.identifyRiskWallets(tokenCA),
        this.getTokenPriceAndSymbol(tokenCA)
      ]);

      const priceInfo = this.unwrap(priceData) || {};

      return {
        // Basic info
        chain: 'SOL',
        token_ca: tokenCA,
        
        // Price and symbol (for position monitor and recording)
        current_price: priceInfo.price || null,
        symbol: priceInfo.symbol || null,

        // Mint authorities
        freeze_authority: this.unwrap(mintInfo)?.freeze_authority || 'Unknown',
        mint_authority: this.unwrap(mintInfo)?.mint_authority || 'Unknown',

        // LP status
        lp_status: this.unwrap(lpStatus)?.status || 'Unknown',
        lp_lock_duration: this.unwrap(lpStatus)?.lock_duration,
        lp_lock_proof: this.unwrap(lpStatus)?.proof,

        // Liquidity
        liquidity: this.unwrap(liquidity)?.liquidity || null,
        liquidity_unit: 'SOL',
        liquidity_usd: this.unwrap(liquidity)?.liquidity_usd || null,

        // Pump.fun 特有数据
        is_pumpfun: this.unwrap(liquidity)?.is_pumpfun || false,
        market_cap: this.unwrap(liquidity)?.market_cap || null,
        volume_24h: this.unwrap(liquidity)?.volume_24h || null,
        txns_24h: this.unwrap(liquidity)?.txns_24h || null,
        bonding_progress: this.unwrap(liquidity)?.bonding_progress || null,

        // Top10
        top10_percent: this.unwrap(top10Data)?.top10_percent || null,
        holder_count: this.unwrap(top10Data)?.holder_count || null,

        // Slippage
        slippage_sell_20pct: this.unwrap(slippageData)?.slippage || null,

        // Wash trading
        wash_flag: this.unwrap(washData)?.flag || 'Unknown',
        wash_score: this.unwrap(washData)?.score || null,

        // Risk wallets
        key_risk_wallets: this.unwrap(riskWallets) || [],

        // Metadata
        snapshot_time: Date.now(),
        data_source: 'DexScreener + Helius + Jupiter'
      };
    } catch (error) {
      console.error(`❌ [SOL] Snapshot error for ${tokenCA}:`, error.message);
      return this.getUnknownSnapshot();
    }
  }

  /**
   * Get Mint and Freeze authorities from token mint account
   */
  async getMintAuthorities(tokenCA) {
    try {
      const mintPubkey = new PublicKey(tokenCA);

      // ⏱️  Rate limiting: wait for token before RPC call
      await this.rateLimiter.throttle();

      const mintInfo = await this.connection.getParsedAccountInfo(mintPubkey);

      if (!mintInfo.value || !mintInfo.value.data.parsed) {
        return { freeze_authority: 'Unknown', mint_authority: 'Unknown' };
      }

      const parsed = mintInfo.value.data.parsed.info;

      return {
        freeze_authority: parsed.freezeAuthority ? 'Enabled' : 'Disabled',
        mint_authority: parsed.mintAuthority ? 'Enabled' : 'Disabled',
        raw_freeze: parsed.freezeAuthority,
        raw_mint: parsed.mintAuthority
      };
    } catch (error) {
      console.error('Error getting mint authorities:', error.message);
      return { freeze_authority: 'Unknown', mint_authority: 'Unknown' };
    }
  }

  /**
   * Get LP status from DexScreener
   */
  async getLPStatus(tokenCA) {
    try {
      const url = `https://api.dexscreener.com/latest/dex/tokens/${tokenCA}`;
      const response = await axios.get(url, { timeout: 10000 });

      if (!response.data.pairs || response.data.pairs.length === 0) {
        return { status: 'Unknown' };
      }

      // Get the largest liquidity pair (usually Raydium)
      const pair = response.data.pairs.reduce((max, p) =>
        (p.liquidity?.usd || 0) > (max.liquidity?.usd || 0) ? p : max
      );

      // Check if LP tokens are burned or locked
      // This requires additional API or on-chain checks
      // For now, use heuristics from DexScreener data

      const lpInfo = pair.liquidity;

      // Check for burn indicators in pair info
      // Note: DexScreener doesn't always provide this directly
      // May need to check LP token holder distribution separately

      let status = 'Unknown';
      let proof = null;

      // Heuristic: Very high liquidity + old pair age = likely burned/locked
      if (lpInfo && lpInfo.usd > 50000 && pair.pairCreatedAt) {
        const ageHours = (Date.now() - pair.pairCreatedAt) / (1000 * 60 * 60);
        if (ageHours > 24) {
          status = 'Likely_Burned_Or_Locked';
          proof = 'Heuristic: High liq + age > 24h';
        }
      }

      // TODO: Implement actual LP token holder check
      // - Get LP token mint address from pair
      // - Check if majority is held by burn address
      // - Check lock platforms (Streamflow, etc.)

      return {
        status,
        lock_duration: null,
        proof,
        pair_address: pair.pairAddress,
        dex: pair.dexId
      };
    } catch (error) {
      console.error('Error getting LP status:', error.message);
      return { status: 'Unknown' };
    }
  }

  /**
   * Get liquidity from DexScreener
   */
  async getLiquidity(tokenCA) {
    try {
      const url = `https://api.dexscreener.com/latest/dex/tokens/${tokenCA}`;
      const response = await axios.get(url, { timeout: 10000 });

      if (!response.data.pairs || response.data.pairs.length === 0) {
        return null;
      }

      // 优先找有 liquidity 的 pair（Raydium 等）
      const pairWithLiquidity = response.data.pairs.find(p => p.liquidity?.usd > 0);
      
      if (pairWithLiquidity) {
        // 正常 DEX pair（有流动性池）
        const liquidityUSD = pairWithLiquidity.liquidity.usd;
        const solPrice = await this.getSOLPrice();
        const liquiditySOL = liquidityUSD / 2 / solPrice;

        return {
          liquidity: liquiditySOL,
          liquidity_usd: liquidityUSD,
          base: pairWithLiquidity.liquidity?.base,
          quote: pairWithLiquidity.liquidity?.quote,
          is_pumpfun: false
        };
      }

      // Pump.fun Bonding Curve（没有 liquidity，用 marketCap 代替）
      const pumpfunPair = response.data.pairs.find(p => p.dexId === 'pumpfun');
      
      if (pumpfunPair) {
        const marketCap = pumpfunPair.marketCap || pumpfunPair.fdv || 0;
        const volume24h = pumpfunPair.volume?.h24 || 0;
        const txns24h = (pumpfunPair.txns?.h24?.buys || 0) + (pumpfunPair.txns?.h24?.sells || 0);
        
        // Pump.fun 的"流动性"用 marketCap 的一定比例估算
        // Bonding curve 机制保证大约 20% 可以即时交易
        const estimatedLiquidity = marketCap * 0.2;
        
        return {
          liquidity: null,
          liquidity_usd: estimatedLiquidity,
          market_cap: marketCap,
          volume_24h: volume24h,
          txns_24h: txns24h,
          is_pumpfun: true,
          bonding_progress: marketCap / 69000 * 100  // 69K 毕业到 Raydium
        };
      }

      // 其他情况，用第一个 pair
      const pair = response.data.pairs[0];
      return {
        liquidity: null,
        liquidity_usd: pair.liquidity?.usd || 0,
        market_cap: pair.marketCap || pair.fdv || 0,
        is_pumpfun: false
      };
    } catch (error) {
      console.error('Error getting liquidity:', error.message);
      return null;
    }
  }

  /**
   * Get SOL price in USD
   */
  async getSOLPrice() {
    try {
      const response = await axios.get(
        'https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd',
        { timeout: 5000 }
      );
      return response.data.solana.usd;
    } catch (error) {
      // Fallback to hardcoded approximate price
      return 100; // Update periodically or use another source
    }
  }

  /**
   * Analyze Top10 holders (excluding pools/exchanges)
   */
  async getTop10Analysis(tokenCA) {
    try {
      // Option 1: Use Helius API (if available)
      if (process.env.HELIUS_API_KEY) {
        return await this.getTop10Helius(tokenCA);
      }

      // Option 2: Use DexScreener holder distribution (if available)
      // Note: DexScreener doesn't always provide this

      // Option 3: Direct RPC call (expensive, may hit rate limits)
      return await this.getTop10RPC(tokenCA);

    } catch (error) {
      console.error('Error analyzing Top10:', error.message);
      return { top10_percent: null, holder_count: null };
    }
  }

  /**
   * Get Top10 using Helius API (preferred)
   */
  async getTop10Helius(tokenCA) {
    try {
      const url = `https://api.helius.xyz/v0/token-metadata?api-key=${process.env.HELIUS_API_KEY}`;
      const response = await axios.post(url, {
        mintAccounts: [tokenCA]
      }, { timeout: 10000 });

      // Helius provides holder distribution
      // Parse and calculate Top10 excluding known addresses

      const holders = response.data[0]?.holders || [];

      // Filter out excluded addresses
      const validHolders = holders.filter(h =>
        !this.excludedAddresses.has(h.address)
      );

      if (validHolders.length === 0) {
        return { top10_percent: null, holder_count: 0 };
      }

      // Sort by balance descending
      validHolders.sort((a, b) => b.amount - a.amount);

      // Calculate Top10 percentage
      const totalSupply = validHolders.reduce((sum, h) => sum + h.amount, 0);
      const top10Supply = validHolders.slice(0, 10).reduce((sum, h) => sum + h.amount, 0);
      const top10Percent = (top10Supply / totalSupply) * 100;

      return {
        top10_percent: top10Percent,
        holder_count: validHolders.length,
        top10_addresses: validHolders.slice(0, 10).map(h => h.address)
      };
    } catch (error) {
      console.error('Helius Top10 error:', error.message);
      throw error;
    }
  }

  /**
   * Get Top10 using direct RPC (fallback, slower)
   */
  async getTop10RPC(tokenCA) {
    try {
      // This is expensive and may not be reliable
      // Use only as last resort
      console.warn('⚠️  Using RPC for Top10 - this is slow and may fail');

      const mintPubkey = new PublicKey(tokenCA);

      // ⏱️  Rate limiting: EXPENSIVE operation - consume 5 tokens
      await this.rateLimiter.throttle(5);

      // Get all token accounts (this can be very large!)
      const accounts = await this.connection.getParsedProgramAccounts(
        new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'),
        {
          filters: [
            { dataSize: 165 },
            { memcmp: { offset: 0, bytes: mintPubkey.toBase58() } }
          ]
        }
      );

      // Parse holders
      const holders = accounts
        .map(acc => ({
          address: acc.account.data.parsed.info.owner,
          amount: acc.account.data.parsed.info.tokenAmount.uiAmount
        }))
        .filter(h => !this.excludedAddresses.has(h.address));

      if (holders.length === 0) {
        return { top10_percent: null, holder_count: 0 };
      }

      holders.sort((a, b) => b.amount - a.amount);

      const totalSupply = holders.reduce((sum, h) => sum + h.amount, 0);
      const top10Supply = holders.slice(0, 10).reduce((sum, h) => sum + h.amount, 0);
      const top10Percent = (top10Supply / totalSupply) * 100;

      return {
        top10_percent: top10Percent,
        holder_count: holders.length,
        top10_addresses: holders.slice(0, 10).map(h => h.address)
      };
    } catch (error) {
      console.error('RPC Top10 error:', error.message);
      return { top10_percent: null, holder_count: null };
    }
  }

  /**
   * Test sell slippage using Jupiter Quote API
   * @param {string} tokenCA - Token contract address
   * @param {number} plannedPosition - Position size in SOL
   */
  async testSlippage(tokenCA, plannedPosition) {
    try {
      const sellTestAmount = plannedPosition * 0.20; // 20% of position

      // Convert SOL amount to token amount (need current price)
      const price = await this.getTokenPrice(tokenCA);
      if (!price) {
        return { slippage: null };
      }

      const tokenAmount = Math.floor((sellTestAmount / price) * 1e9); // Convert to lamports

      // Get Jupiter quote for selling
      const url = `https://quote-api.jup.ag/v6/quote?inputMint=${tokenCA}&outputMint=So11111111111111111111111111111111111111112&amount=${tokenAmount}&slippageBps=100`;

      const response = await axios.get(url, { timeout: 10000 });

      if (!response.data || !response.data.routePlan) {
        return { slippage: null };
      }

      const quote = response.data;

      // Calculate slippage from quote
      const expectedOut = quote.outAmount;
      const minOut = quote.otherAmountThreshold;
      const slippagePct = ((expectedOut - minOut) / expectedOut) * 100;

      return {
        slippage: slippagePct,
        expected_out_lamports: expectedOut,
        min_out_lamports: minOut,
        price_impact: quote.priceImpactPct
      };
    } catch (error) {
      console.error('Error testing slippage:', error.message);
      return { slippage: null };
    }
  }

  /**
   * Get token price from DexScreener
   */
  async getTokenPrice(tokenCA) {
    try {
      const url = `https://api.dexscreener.com/latest/dex/tokens/${tokenCA}`;
      const response = await axios.get(url, { timeout: 10000 });

      if (!response.data.pairs || response.data.pairs.length === 0) {
        return null;
      }

      const pair = response.data.pairs[0];
      return parseFloat(pair.priceUsd) || null;
    } catch (error) {
      console.error('Error getting token price:', error.message);
      return null;
    }
  }

  /**
   * Get token price and symbol from DexScreener (combined call)
   */
  async getTokenPriceAndSymbol(tokenCA) {
    try {
      const url = `https://api.dexscreener.com/latest/dex/tokens/${tokenCA}`;
      const response = await axios.get(url, { timeout: 10000 });

      if (!response.data.pairs || response.data.pairs.length === 0) {
        return { price: null, symbol: null };
      }

      const pair = response.data.pairs[0];
      return {
        price: parseFloat(pair.priceUsd) || null,
        symbol: pair.baseToken?.symbol || null
      };
    } catch (error) {
      console.error('Error getting token price and symbol:', error.message);
      return { price: null, symbol: null };
    }
  }

  /**
   * Detect wash trading (heuristic-based)
   */
  async detectWashTrading(tokenCA) {
    try {
      const url = `https://api.dexscreener.com/latest/dex/tokens/${tokenCA}`;
      const response = await axios.get(url, { timeout: 10000 });

      if (!response.data.pairs || response.data.pairs.length === 0) {
        return { flag: 'Unknown', score: null };
      }

      const pair = response.data.pairs[0];
      const txns = pair.txns || {};

      // Heuristics for wash trading:
      // 1. High transaction count but low unique traders
      // 2. Very balanced buy/sell ratio (close to 50/50)
      // 3. Transactions clustered in time
      // 4. Small volume per transaction (many small txns)

      let score = 0;
      const reasons = [];

      // H1: Check buy/sell balance (too perfect = suspicious)
      const h24 = txns.h24 || {};
      const buys = h24.buys || 0;
      const sells = h24.sells || 0;
      const total = buys + sells;

      if (total > 0) {
        const buyRatio = buys / total;
        if (buyRatio > 0.45 && buyRatio < 0.55) {
          score += 30;
          reasons.push('Suspiciously balanced buy/sell ratio');
        }
      }

      // H2: High txn count but low volume (many small wash trades)
      const volume24h = parseFloat(pair.volume?.h24 || 0);
      if (total > 100 && volume24h > 0) {
        const avgTxnSize = volume24h / total;
        if (avgTxnSize < 100) { // Average txn < $100
          score += 30;
          reasons.push('Many small transactions');
        }
      }

      // H3: Check price volatility vs volume (low vol with high txn = wash)
      const priceChange = Math.abs(parseFloat(pair.priceChange?.h24 || 0));
      if (priceChange < 5 && total > 200) {
        score += 20;
        reasons.push('Low price movement despite high txn count');
      }

      // Determine flag
      let flag;
      if (score >= 60) {
        flag = 'HIGH';
      } else if (score >= 30) {
        flag = 'MEDIUM';
      } else {
        flag = 'LOW';
      }

      return {
        flag,
        score,
        reasons: reasons.length > 0 ? reasons : null
      };
    } catch (error) {
      console.error('Error detecting wash trading:', error.message);
      return { flag: 'Unknown', score: null };
    }
  }

  /**
   * Identify key risk wallets (early large buyers, new wallets)
   */
  async identifyRiskWallets(tokenCA) {
    try {
      // This requires transaction history analysis
      // Ideally use Helius or Birdeye for this

      if (process.env.HELIUS_API_KEY) {
        return await this.getRiskWalletsHelius(tokenCA);
      }

      // Fallback: Return empty for now
      return [];
    } catch (error) {
      console.error('Error identifying risk wallets:', error.message);
      return [];
    }
  }

  /**
   * Get risk wallets using Helius Enhanced Transactions API
   */
  async getRiskWalletsHelius(tokenCA) {
    try {
      // Use Helius Enhanced Transactions API (provides parsed data)
      const url = `${this.heliusApiUrl}/addresses/${tokenCA}/transactions?api-key=${this.heliusApiKey}`;

      const response = await axios.get(url, {
        params: {
          limit: 100,
          type: 'SWAP' // Filter for swap transactions only
        },
        timeout: 10000
      });

      const transactions = response.data || [];

      // Analyze for risk patterns
      const riskWallets = [];
      const walletStats = new Map(); // wallet -> {first_buy_time, total_amount, tx_count}

      for (const tx of transactions) {
        try {
          // Helius provides parsed transaction data
          const timestamp = tx.timestamp;
          const signature = tx.signature;

          // Extract swap information from native transfers and token balances
          const nativeTransfers = tx.nativeTransfers || [];
          const tokenTransfers = tx.tokenTransfers || [];

          // Identify buyer (who received the token)
          for (const transfer of tokenTransfers) {
            if (transfer.mint === tokenCA && transfer.toUserAccount) {
              const buyer = transfer.toUserAccount;
              const amount = transfer.tokenAmount;

              if (!walletStats.has(buyer)) {
                walletStats.set(buyer, {
                  first_buy_time: timestamp,
                  total_bought: 0,
                  tx_count: 0,
                  largest_buy: 0
                });
              }

              const stats = walletStats.get(buyer);
              stats.total_bought += amount;
              stats.tx_count += 1;
              stats.largest_buy = Math.max(stats.largest_buy, amount);
            }
          }
        } catch (txError) {
          // Skip malformed transactions
          continue;
        }
      }

      // Identify risk patterns
      const now = Date.now();
      const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;

      for (const [wallet, stats] of walletStats.entries()) {
        const walletAge = now - (stats.first_buy_time * 1000); // Convert to ms

        // Risk Pattern 1: Early large buyer (top 10% of buy volume in first 100 txs)
        // Risk Pattern 2: New wallet (< 7 days old) with significant position

        let riskScore = 0;
        const reasons = [];

        // Check if wallet is very new
        if (walletAge < sevenDaysMs) {
          riskScore += 30;
          reasons.push('New wallet (< 7 days)');
        }

        // Check if early buyer (in first 20 transactions)
        const firstBuyIndex = transactions.findIndex(tx =>
          tx.tokenTransfers?.some(t => t.toUserAccount === wallet)
        );

        if (firstBuyIndex !== -1 && firstBuyIndex < 20) {
          riskScore += 25;
          reasons.push(`Early buyer (tx #${firstBuyIndex + 1})`);
        }

        // Check for concentrated buying (high tx count early)
        if (stats.tx_count >= 5) {
          riskScore += 20;
          reasons.push(`Multiple early buys (${stats.tx_count}x)`);
        }

        // Flag as risk if score >= 50
        if (riskScore >= 50) {
          riskWallets.push({
            address: wallet,
            risk_score: riskScore,
            reasons: reasons.join(', '),
            first_buy_time: stats.first_buy_time,
            total_bought: stats.total_bought,
            tx_count: stats.tx_count
          });
        }
      }

      console.log(`🔍 [SOL] Helius found ${riskWallets.length} risk wallets`);
      return riskWallets;

    } catch (error) {
      console.error('❌ [SOL] Helius risk wallets error:', error.message);
      return []; // Fail silently, not critical
    }
  }

  /**
   * Helper: Unwrap Promise.allSettled result
   */
  unwrap(settledResult) {
    return settledResult.status === 'fulfilled' ? settledResult.value : null;
  }

  /**
   * Return Unknown snapshot when all checks fail
   */
  /**
   * Get Token Metadata (name, symbol, description)
   * Uses Alchemy getAsset API
   *
   * @param {string} tokenCA - Token contract address
   * @returns {Promise<Object>} { name, symbol, description }
   */
  async getTokenMetadata(tokenCA) {
    // 尝试多个 API 源获取 metadata
    
    // 1. 先尝试 DexScreener（免费且稳定）
    try {
      const dexResponse = await axios.get(
        `https://api.dexscreener.com/latest/dex/tokens/${tokenCA}`,
        { timeout: 5000 }
      );
      
      const pair = dexResponse.data?.pairs?.[0];
      if (pair?.baseToken) {
        const metadata = {
          name: pair.baseToken.name || null,
          symbol: pair.baseToken.symbol || null,
          description: null
        };
        if (metadata.name || metadata.symbol) {
          console.log(`   📝 Token: ${metadata.name || 'Unknown'} (${metadata.symbol || 'Unknown'}) [DexScreener]`);
          return metadata;
        }
      }
    } catch (error) {
      // DexScreener 失败，继续尝试其他 API
    }

    // 2. 尝试 Pump.fun API（对于 pump 结尾的地址）
    if (tokenCA.toLowerCase().endsWith('pump')) {
      try {
        const pumpResponse = await axios.get(
          `https://frontend-api.pump.fun/coins/${tokenCA}`,
          { timeout: 5000 }
        );
        
        if (pumpResponse.data) {
          const metadata = {
            name: pumpResponse.data.name || null,
            symbol: pumpResponse.data.symbol || null,
            description: pumpResponse.data.description || null
          };
          if (metadata.name || metadata.symbol) {
            console.log(`   📝 Token: ${metadata.name || 'Unknown'} (${metadata.symbol || 'Unknown'}) [Pump.fun]`);
            return metadata;
          }
        }
      } catch (error) {
        // Pump.fun 失败，继续
      }
    }

    // 3. 最后尝试 Alchemy（可能 503）
    if (!this.alchemyApiKey) {
      return { name: null, symbol: null, description: null };
    }

    try {
      await this.rateLimiter.throttle();

      const response = await axios.post(
        `https://solana-mainnet.g.alchemy.com/v2/${this.alchemyApiKey}`,
        {
          jsonrpc: '2.0',
          id: 'metadata-fetch',
          method: 'getAsset',
          params: {
            id: tokenCA,
            displayOptions: {
              showCollectionMetadata: true
            }
          }
        },
        {
          timeout: 10000,
          headers: { 'Content-Type': 'application/json' }
        }
      );

      const asset = response.data?.result;

      if (!asset) {
        return { name: null, symbol: null, description: null };
      }

      const metadata = {
        name: asset.content?.metadata?.name || null,
        symbol: asset.content?.metadata?.symbol || null,
        description: asset.content?.metadata?.description || null
      };

      if (metadata.name || metadata.symbol) {
        console.log(`   📝 Token: ${metadata.name || 'Unknown'} (${metadata.symbol || 'Unknown'}) [Alchemy]`);
      }

      return metadata;

    } catch (error) {
      console.log(`   ⚠️  Token metadata fetch failed: ${error.message}`);
      return { name: null, symbol: null, description: null };
    }
  }

  getUnknownSnapshot() {
    return {
      chain: 'SOL',
      current_price: null,
      symbol: null,
      freeze_authority: 'Unknown',
      mint_authority: 'Unknown',
      lp_status: 'Unknown',
      liquidity: null,
      liquidity_usd: null,
      liquidity_unit: 'SOL',
      top10_percent: null,
      slippage_sell_20pct: null,
      wash_flag: 'Unknown',
      key_risk_wallets: [],
      snapshot_time: Date.now(),
      data_source: 'Failed'
    };
  }
}

export default SolanaSnapshotService;
