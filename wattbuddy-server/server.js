const express = require('express');
const cors = require('cors');
const http = require('http');
const socketIO = require('socket.io');
const moment = require('moment');
const cron = require('node-cron');
const axios = require('axios');

const app = express();
const server = http.createServer(app);

// ESP32 IP Address - Update this to match your ESP32's IP
// Windows Mobile Hotspot: 192.168.137.154
const ESP32_IP = '192.168.137.154';
const ESP32_PORT = 80;

// Use Socket.io to broadcast data to your Flutter App/Dashboard
const io = socketIO(server, { 
    cors: { origin: "*" },
    transports: ['websocket', 'polling'] 
});

// ============ IN-MEMORY CACHE ============
let esp32LatestData = {
  voltage: 0, 
  current: 0, 
  power: 0, 
  energy: 0,
  relay1: 0, 
  relay2: 0, 
  userId: null,
  timestamp: new Date().toISOString()
};

// Track last database write to optimize database growth
let lastDbWrite = {
  timestamp: 0,
  energy_consumed: 0
};

// ============ PATTERN LEARNING IN-MEMORY STRUCTURES ============
// Relay Power Attribution Tracking (for socket identification)
let relayToggleEvents = {};

// User Power Consumption History (moving window, max 100 readings per user)
let userPowerHistory = {};

// Alert Dismissal Tracking (for 2-minute re-alert logic)
let dismissedAlerts = {};

// Socket Power Signatures (learned from relay toggles)
let socketPowerSignatures = {};

// Track previous relay states to detect toggles
let previousRelayStates = {};

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ============ SERVICES & ROUTES ============
const ESP32StorageService = require('./services/esp32StorageService');
const RealtimeGraphService = require('./services/realtimeGraphService');
const MLPredictionService = require('./services/mlPredictionService');
const PowerLimitService = require('./services/powerLimitService');
const MonthlyUsageService = require('./services/monthlyUsageService');
const DailyAnalyticsService = require('./services/dailyAnalyticsService');
const GoalTrackingService = require('./services/goalTrackingService');
const RewardSystemService = require('./services/rewardSystemService');
const BillingService = require('./services/billingService');
const PushNotificationService = require('./services/pushNotificationService');
const GoalRewardService = require('./services/goalRewardService');
const MonthlySnapshotService = require('./services/monthlySnapshotService');
const PatternAnalysisService = require('./services/patternAnalysisService');

const authRoutes = require('./routes/authRoutes');
const mlRoutes = require('./routes/mlRoutes');
const usageRoutes = require('./routes/usageRoutes');
const predictionRoutes = require('./routes/predictionRoutes');
const notificationRoutes = require('./routes/notificationRoutes');
const goalRoutes = require('./routes/goalRoutes');
const rewardRoutes = require('./routes/rewardRoutes');
const goalRewardRoutes = require('./routes/goalRewardRoutes');

app.use('/api/auth', authRoutes);
app.use('/api/ml', mlRoutes);
app.use('/api/usage', usageRoutes);
app.use('/api/predictions', predictionRoutes);
app.use('/api/notifications', notificationRoutes);
app.use('/api/goals', goalRoutes);
app.use('/api/rewards', rewardRoutes);
app.use('/api/goal-rewards', goalRewardRoutes);

// Initialize Firebase Push Notifications
PushNotificationService.initialize();

// Initialize schema for goal-based reward module
GoalRewardService.ensureSchema().catch(err => {
  console.error('❌ Goal reward schema init failed:', err);
});

// Initialize schema for monthly snapshot billing
MonthlySnapshotService.ensureSchema().catch(err => {
  console.error('❌ Monthly snapshot schema init failed:', err);
});

// Initialize schema for pattern analysis & smart dismissal
PatternAnalysisService.ensureSchema().catch(err => {
  console.error('❌ Pattern analysis schema init failed:', err);
});

// ============ TEST ROUTE ============
app.get('/', (req, res) => {
  res.send('🚀 WattBuddy Server Running');
});

// ============ 2️⃣ ESP32 DATA RECEIVER (MODIFIED TO SAVE TO DB) ============
app.post('/api/esp32/data', async (req, res) => {
  try {
    // Accept either `energy` or `energy_consumed` from different firmware versions
    const { voltage, current, power, energy, energy_consumed, relay1, relay2, userId, dominantRelay, dominantPower } = req.body;
    const pool = require('./db');
    const now = Date.now();

    console.log(`📥 [ESP32 POST RECEIVED] Raw body:`, JSON.stringify(req.body));

    const parsedVoltage = parseFloat(voltage) || 0;
    const parsedCurrent = parseFloat(current) || 0;
    const parsedPower = parseFloat(power) || 0;
    const parsedEnergy = parseFloat(energy !== undefined ? energy : energy_consumed) || 0;
    const parsedRelay1 = parseInt(relay1) || 0;
    const parsedRelay2 = parseInt(relay2) || 0;
    const parsedDominantRelay = parseInt(dominantRelay) || 0;
    const parsedDominantPower = parseFloat(dominantPower) || 0;

    console.log(`✅ [PARSED VALUES] V=${parsedVoltage}, I=${parsedCurrent}, P=${parsedPower}, E=${parsedEnergy}, R1=${parsedRelay1}, R2=${parsedRelay2}`);

    Object.assign(esp32LatestData, {
      voltage: parsedVoltage,
      current: parsedCurrent,
      power: parsedPower,
      energy: parsedEnergy,
      relay1: parsedRelay1,
      relay2: parsedRelay2,
      userId: (userId !== undefined && userId !== null) ? String(userId) : null,
      dominantRelay: parsedDominantRelay,
      dominantPower: parsedDominantPower,
      timestamp: new Date().toISOString()
    });

    console.log(`💾 [CACHE UPDATED]`, JSON.stringify(esp32LatestData));

    io.emit('live_data_update', esp32LatestData);

    // Decide DB write quickly and ACK immediately so ESP32 does not time out.
    const timeSinceLastWrite = now - lastDbWrite.timestamp;
    const energyDifference = Math.abs(parsedEnergy - (parseFloat(lastDbWrite.energy_consumed) || 0));
    const shouldWrite = timeSinceLastWrite >= 60000 || energyDifference >= 0.001;

    res.json({ success: true, accepted: true, data: esp32LatestData, dbWrite: shouldWrite });

    // Continue heavy work in background.
    setImmediate(async () => {
      try {
        try {
          const activeUserId = userId || '8';
          const currentPower = parsedPower;

          // Step 1: Record relay toggle for socket signature learning
          const prevState = previousRelayStates[activeUserId] || { relay1: parsedRelay1, relay2: parsedRelay2, power: currentPower };
          if (prevState.relay1 !== parsedRelay1 || prevState.relay2 !== parsedRelay2) {
            await PatternAnalysisService.recordToggleEvent(
              activeUserId,
              prevState.relay1,
              parsedRelay1,
              prevState.relay2,
              parsedRelay2,
              prevState.power,
              currentPower
            );
          }
          previousRelayStates[activeUserId] = { relay1: parsedRelay1, relay2: parsedRelay2, power: currentPower };

          // Step 2: Get user baseline (grace period check)
          const baseline = await DailyAnalyticsService.getUserBaseline(activeUserId);

          if (baseline.isInGracePeriod) {
            console.log(`📚 [LEARNING MODE] User ${activeUserId} in grace period (${Math.floor(baseline.daysSinceSignup || 0)} days). Alerts suppressed.`);
          } else {
            if ((baseline.sampleSize || 0) < 1) {
              console.log(`📊 [HISTORY CHECK] User ${activeUserId} has limited baseline history (${baseline.sampleSize || 0} day). Pattern/baseline analysis will continue with available data.`);
            }

            // Step 3: Pattern-based detection (NEW enhancement)
            let patternDeviation = null;
            let expectedPowerRange = null;

            // Try to analyze patterns from 30-day history
            let patterns = null;
            try {
              patterns = await PatternAnalysisService.analyzeConsumptionPatterns(activeUserId);
              if (patterns && patterns.length > 0) {
                const patternData = await PatternAnalysisService.detectPatternDeviation(activeUserId, currentPower, patterns);
                if (patternData && patternData.isDeviation && patternData.zScore > 2) {
                  patternDeviation = patternData;
                  expectedPowerRange = patternData.expectedRange;
                }
              }
            } catch (pErr) {
              // Silently continue with baseline if pattern detection fails
            }

            // Step 4: Traditional baseline anomaly detection
            const anomaly = await DailyAnalyticsService.detectPowerAnomaly(activeUserId, currentPower);

            // Step 5: Determine if alert should be sent (pattern OR baseline)
            const shouldAlert = (anomaly.isAnomaly || patternDeviation) && currentPower >= 10;

            if (shouldAlert) {
              // Step 6: Get socket signatures learned from relay toggles
              let socketSignatures = null;
              try {
                socketSignatures = await PatternAnalysisService.getSocketSignatures(activeUserId);
              } catch (sigErr) {
                // Continue without signatures
              }

              // Step 7: Attribute power to specific socket (NEW enhancement)
              const attribution = await PatternAnalysisService.attributePowerToSocket(
                activeUserId,
                currentPower,
                parsedRelay1,
                parsedRelay2,
                socketSignatures
              );

              let problemSocket = attribution.socket > 0 ? `Socket ${attribution.socket}` : 'Unknown Socket';
              let confidence = attribution.confidence;
              let anomalySource = patternDeviation ? 'PATTERN' : 'BASELINE';

              let detailMsg = '';
              if (patternDeviation) {
                detailMsg = ` Expected ~${patternDeviation.expectedAvg.toFixed(0)}W for this time, got ${currentPower.toFixed(0)}W (z=${patternDeviation.zScore.toFixed(2)})`;
              } else {
                detailMsg = ` (normal=${(baseline.mean || 0).toFixed(0)}W, threshold=${(anomaly.threshold || baseline.threshold || 0).toFixed(0)}W, z=${(anomaly.zScore || 0).toFixed(2)})`;
              }

              const alertId = `${activeUserId}_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

              const anomalyData = {
                alertId,
                isAbnormal: true,
                anomalySocket: problemSocket,
                anomalySocketId: attribution.socket,
                confidence,
                anomalySource,
                currentPower,
                threshold: anomaly.threshold || baseline.threshold || 0,
                userMean: baseline.mean || 0,
                zScore: patternDeviation ? patternDeviation.zScore : (anomaly.zScore || 0),
                severity: (patternDeviation ? patternDeviation.severity : anomaly.severity) || 'normal',
                expectedRange: expectedPowerRange,
                relay1State: parsedRelay1,
                relay2State: parsedRelay2,
                message: `⚠️ ${anomalySource}: ${problemSocket} drawing ${currentPower.toFixed(0)}W!${detailMsg}`,
                timestamp: new Date().toISOString(),
                userId: activeUserId,
              };

              io.emit('anomaly_alert', anomalyData);
              console.log(`🚨 [${anomalySource} ALERT] user=${activeUserId}, socket=${problemSocket}, confidence=${confidence}, power=${currentPower.toFixed(1)}W`);

              PushNotificationService.sendAnomalyAlert(activeUserId, anomalyData)
                .then((result) => {
                  if (result.success) {
                    console.log(`📱 Push notification sent to user ${activeUserId}`);
                  } else {
                    console.log(`⚠️ Push notification skipped: ${result.error}`);
                  }
                })
                .catch((err) => console.error('❌ Push notification error:', err));
            }
          }
        } catch (mlErr) {
          console.error('❌ Pattern-based anomaly detection failed:', mlErr);
        }

        if (shouldWrite) {
          const incomingEnergy = parsedEnergy;
          const lastEnergy = parseFloat(lastDbWrite.energy_consumed) || incomingEnergy;
          const increment = incomingEnergy > lastEnergy ? (incomingEnergy - lastEnergy) : 0;

          const insertQuery = `
            INSERT INTO "EnergyReadings" (user_id, voltage, current, power, energy_consumed, relay1, relay2, timestamp)
            VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
          `;
          await pool.query(insertQuery, [userId || '8', parsedVoltage, parsedCurrent, parsedPower, incomingEnergy, parsedRelay1, parsedRelay2]);

          try {
            const updateQuery = `
              UPDATE "UserStats"
              SET total_energy = total_energy + $1
              WHERE user_id = $2
            `;
            const updateRes = await pool.query(updateQuery, [increment, userId || '8']);

            if (updateRes.rowCount === 0 && increment > 0) {
              const insertStats = `
                INSERT INTO "UserStats" (user_id, total_energy, created_at)
                VALUES ($1, $2, NOW())
              `;
              await pool.query(insertStats, [userId || '8', increment]);
            }
          } catch (errStats) {
            console.error('❌ Failed to update UserStats:', errStats);
          }

          lastDbWrite.timestamp = now;
          lastDbWrite.energy_consumed = incomingEnergy;

          try {
            const uid = parseInt(userId) || 8;
            await pool.query(
              `INSERT INTO energy_readings (user_id, power_consumption, voltage, current, recorded_at)
               VALUES ($1, $2, $3, $4, NOW())`,
              [uid, parsedPower, parsedVoltage, parsedCurrent]
            );
            console.log('💾 [ALT DB SAVE] energy_readings row inserted');
          } catch (errAlt) {
            console.error('❌ Failed to insert into energy_readings fallback:', errAlt.message || errAlt);
          }

          DailyAnalyticsService.aggregateDailyUsage(userId || '8').catch(err => {
            console.error('❌ Failed to aggregate daily usage:', err);
          });

          GoalTrackingService.checkAndResetDaily(userId || '8').then(async (resetResult) => {
            try {
              const progress = await GoalTrackingService.getCurrentProgress(userId || '8');

              io.emit('goal_progress_update', {
                userId: userId || '8',
                daily: progress.daily,
                monthly: progress.monthly,
                timestamp: new Date().toISOString()
              });

              if (progress.daily.exceeded) {
                io.emit('goal_alert', {
                  type: 'daily_exceeded',
                  userId: userId || '8',
                  message: `⚠️ Daily limit exceeded! Used ${progress.daily.currentUsage.toFixed(2)} kWh of ${progress.daily.totalAvailable.toFixed(2)} kWh available (${progress.daily.dailyLimit.toFixed(2)} + ${progress.daily.carriedOver.toFixed(2)} carried over)`,
                  progress: progress.daily,
                  timestamp: new Date().toISOString()
                });
                console.log(`🚨 [GOAL ALERT] Daily limit exceeded for user ${userId || '8'}`);
              } else if (progress.daily.percentageUsed > 80 && progress.daily.percentageUsed <= 100) {
                io.emit('goal_alert', {
                  type: 'daily_warning',
                  userId: userId || '8',
                  message: `⚠️ Approaching daily limit: ${progress.daily.percentageUsed.toFixed(0)}% used (${progress.daily.currentUsage.toFixed(2)} / ${progress.daily.totalAvailable.toFixed(2)} kWh)`,
                  progress: progress.daily,
                  timestamp: new Date().toISOString()
                });
              }

              if (progress.monthly.exceeded) {
                io.emit('goal_alert', {
                  type: 'monthly_exceeded',
                  userId: userId || '8',
                  message: `⚠️ Monthly limit exceeded! Used ${progress.monthly.currentUsage.toFixed(2)} kWh of ${progress.monthly.monthlyLimit.toFixed(2)} kWh limit`,
                  progress: progress.monthly,
                  timestamp: new Date().toISOString()
                });
                console.log(`🚨 [GOAL ALERT] Monthly limit exceeded for user ${userId || '8'}`);
              } else if (progress.monthly.percentageUsed > 80 && progress.monthly.percentageUsed <= 100) {
                io.emit('goal_alert', {
                  type: 'monthly_warning',
                  userId: userId || '8',
                  message: `⚠️ Approaching monthly limit: ${progress.monthly.percentageUsed.toFixed(0)}% used (${progress.monthly.currentUsage.toFixed(2)} / ${progress.monthly.monthlyLimit.toFixed(2)} kWh)`,
                  progress: progress.monthly,
                  timestamp: new Date().toISOString()
                });
              }

              // Reward the finalized previous day only once reset rolls over to a new day.
              if (resetResult && resetResult.resetNeeded && resetResult.previousDate) {
                const pointsResult = await RewardSystemService.calculateDailyPoints(
                  userId || '8',
                  resetResult.previousDate
                );
                const rewards = await RewardSystemService.getUserRewards(userId || '8');

                io.emit('reward_update', {
                  userId: userId || '8',
                  rewardDate: resetResult.previousDate,
                  pointsEarned: pointsResult.pointsEarned,
                  reasons: pointsResult.reasons,
                  totalPoints: rewards.totalPoints,
                  tier: rewards.tier,
                  currentStreak: rewards.currentStreak,
                  achievementsUnlocked: rewards.achievementsUnlocked,
                  progressToNextTier: rewards.progressToNextTier,
                  timestamp: new Date().toISOString()
                });

                if (pointsResult.pointsEarned > 0) {
                  console.log(`⭐ [REWARDS] User ${userId || '8'} earned ${pointsResult.pointsEarned} points for ${resetResult.previousDate}`);
                  console.log(`   Reasons: ${pointsResult.reasons.join(' | ')}`);
                }
              }
            } catch (goalErr) {
              console.error('❌ Failed to check goal progress:', goalErr);
            }
          }).catch(err => {
            console.error('❌ Failed daily reset check:', err);
          });

          console.log(`📊 [ESP32 DB Save] V: ${parsedVoltage}V | I: ${parsedCurrent}A | P: ${parsedPower}W | E: ${incomingEnergy}kWh | inc: ${increment.toFixed(6)} | User: ${userId || '8'}`);
        } else {
          console.log(`📡 [ESP32 Live] V: ${parsedVoltage}V | I: ${parsedCurrent}A | P: ${parsedPower}W | E: ${parsedEnergy}kWh (Cache only)`);
        }
      } catch (bgErr) {
        console.error('❌ Background ESP32 processing failed:', bgErr);
      }
    });
  } catch (error) {
    console.error('❌ Error processing ESP32 data:', error);
    res.status(500).json({ error: error.message });
  }
});

// ============ GET LATEST DATA ============
app.get('/esp32/latest', (req, res) => {
  try {
    res.json({ success: true, data: esp32LatestData });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============ USAGE SUMMARY (Fixes Last Month & Current Month) ============
app.get('/api/usage/summary/:userId', async (req, res) => {
    try {
        const { userId } = req.params;
        const pool = require('./db');

        // Use snapshot-based method for current month, with fallback to MAX-MIN
        let currentMonth = 0;
        try {
            currentMonth = await MonthlySnapshotService.getCurrentMonthUsage(userId);
        } catch (err) {
            console.warn('⚠️ Snapshot method failed for current month, using MAX-MIN:', err);
            const currentQuery = `
                SELECT COALESCE(MAX(energy_consumed) - MIN(energy_consumed), 0) as kwh
                FROM "EnergyReadings"
                WHERE user_id = $1::text 
                  AND timestamp >= DATE_TRUNC('month', CURRENT_DATE)
            `;
            const result = await pool.query(currentQuery, [userId]);
            currentMonth = parseFloat(result.rows?.[0]?.kwh) || 0;
        }

        // Use snapshot-based method for last month, with fallback to MAX-MIN
        const lastMonthYear = new Date();
        lastMonthYear.setMonth(lastMonthYear.getMonth() - 1);
        const lastMonth = lastMonthYear.getMonth() + 1;
        const lastYear = lastMonthYear.getFullYear();

        let lastMonthUsage = 0;
        try {
            lastMonthUsage = await MonthlySnapshotService.getMonthUsage(userId, lastYear, lastMonth);
        } catch (err) {
            console.warn('⚠️ Snapshot method failed for last month, using MAX-MIN:', err);
            const lastMonthQuery = `
                SELECT COALESCE(MAX(energy_consumed) - MIN(energy_consumed), 0) as kwh
                FROM "EnergyReadings"
                WHERE user_id = $1::text 
                  AND timestamp >= DATE_TRUNC('month', CURRENT_DATE - INTERVAL '1 month')
                  AND timestamp < DATE_TRUNC('month', CURRENT_DATE)
            `;
            const result = await pool.query(lastMonthQuery, [userId]);
            lastMonthUsage = parseFloat(result.rows?.[0]?.kwh) || 0;
        }

        // Get historical average power
        const avgQuery = `
            SELECT COALESCE(AVG(power), 0) as historical_avg_power
            FROM "EnergyReadings"
            WHERE user_id = $1::text
        `;
        const avgResult = await pool.query(avgQuery, [userId]);
        const historicalAvgPower = parseFloat(avgResult.rows?.[0]?.historical_avg_power) || 0;

        const currentMonthKwh = currentMonth;
        const lastMonthKwh = lastMonthUsage;

        // Dynamic anomaly detection based on user's historical patterns
        let isAbnormal = false;
        let anomalySocket = null;
        let currentPower = 0;
        let anomalyThreshold = 150; // Default fallback

        try {
          const latestRes = await pool.query(
            `SELECT power, relay1, relay2, timestamp
             FROM "EnergyReadings"
             WHERE user_id = $1::text
             ORDER BY timestamp DESC
             LIMIT 1`,
            [userId]
          );

          if (latestRes.rows.length > 0) {
            const latest = latestRes.rows[0];
            currentPower = parseFloat(latest.power || 0);

            const relay1 = parseInt(latest.relay1 ?? 0);
            const relay2 = parseInt(latest.relay2 ?? 0);

            // Use dynamic threshold from user's baseline statistics (mean + 2*stddev)
            const anomalyResult = await DailyAnalyticsService.detectPowerAnomaly(userId, currentPower);
            isAbnormal = anomalyResult.isAnomaly;
            anomalyThreshold = anomalyResult.threshold;

            console.log(`📊 Anomaly check: power=${currentPower}W, threshold=${anomalyThreshold.toFixed(1)}W, isAnomaly=${isAbnormal}, severity=${anomalyResult.severity}`);

            if (isAbnormal) {
              if (relay1 === 1 && relay2 !== 1) {
                anomalySocket = 'Socket 1';
              } else if (relay2 === 1 && relay1 !== 1) {
                anomalySocket = 'Socket 2';
              } else {
                anomalySocket = 'Both Sockets';
              }
            }
          }
        } catch (anomalyErr) {
          console.warn('⚠️ Failed to compute anomaly summary:', anomalyErr.message || anomalyErr);
        }

        res.json({
            success: true,
            currentMonthKwh,
            lastMonthKwh,
            historicalAvg: historicalAvgPower,
            historicalAvgPower,
            daysElapsed: new Date().getDate(),
            // Anomaly fields expected by Flutter `BillPredictionScreen`
            isAbnormal,
            anomalySocket,
            currentPower,
            anomalyThreshold, // Dynamic threshold based on user's historical patterns
        });
    } catch (err) {
        console.error('❌ Usage Summary Error:', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

// ============ DAILY HISTORY (For Bar Chart) ============
app.get('/api/usage/daily-history/:userId', async (req, res) => {
    try {
        const { userId } = req.params;
        
        // Use daily_usage table with fallback to EnergyReadings if no data
        const dailyHistory = await DailyAnalyticsService.getCurrentMonthDailyUsage(userId);
        
        res.json(dailyHistory);
    } catch (err) {
        console.error('❌ Daily history error:', err);
        res.status(500).json({ error: err.message });
    }
});

// ============ FETCH CALCULATED BILL FROM SQL VIEW ============
app.get('/api/billing/current/:userId', async (req, res) => {
    try {
        const { userId } = req.params;
        const pool = require('./db');
        
        // Prefer SQL View (if present), but gracefully fallback if it doesn't exist.
        try {
            const result = await pool.query(
                'SELECT * FROM view_user_bills WHERE user_id = $1',
                [userId]
            );

            if (result.rows.length > 0) {
                return res.json({ success: true, billing: result.rows[0], source: 'view_user_bills' });
            }
        } catch (viewErr) {
            console.warn('⚠️ view_user_bills unavailable, falling back:', viewErr.message || viewErr);
        }

        // Fallback: compute current-month usage using snapshot-based method
        let kwh = 0;
        try {
            kwh = await MonthlySnapshotService.getCurrentMonthUsage(userId);
        } catch (snapshotErr) {
            console.warn('⚠️ Snapshot method failed, using MAX-MIN fallback:', snapshotErr);
            // Ultimate fallback: MAX-MIN method
            const usageQuery = `
                SELECT
                    COALESCE(MAX(energy_consumed) - MIN(energy_consumed), 0) AS total_units_kwh
                FROM "EnergyReadings"
                WHERE user_id = $1::text
                  AND timestamp >= DATE_TRUNC('month', CURRENT_DATE)
            `;
            const usageRes = await pool.query(usageQuery, [userId]);
            kwh = parseFloat(usageRes.rows?.[0]?.total_units_kwh) || 0;
        }

        // Simple tariff fallback (aligns with Flutter defaults)
        const baseCharge = 50;
        const ratePerKwh = 10;
        const billRs = baseCharge + (kwh * ratePerKwh);

        return res.json({
            success: true,
            source: 'EnergyReadings_fallback',
            billing: {
                user_id: userId,
                total_units_kwh: kwh,
                slab_bill_rs: billRs,
                base_charge_rs: baseCharge,
                rate_per_kwh: ratePerKwh,
            }
        });
    } catch (err) {
        console.error('❌ Error fetching current bill:', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

// ============ FETCH HISTORICAL BILLS ============
// Used by the Flutter `BillHistoryScreen` and `BillHistoryService`
app.get('/api/billing/history/:userId', async (req, res) => {
    try {
        const { userId } = req.params;
        const pool = require('./db');

        // Compute monthly usage and bill for past months using energy readings.
        // Amount calculation mirrors the same fallback logic used above.
        const historyQuery = `
            SELECT
                to_char(month, 'Mon YYYY') AS period,
                to_char(month + interval '1 month' - interval '1 day', 'Mon DD, YYYY') AS "dueDate",
                (kwh * 10 + 50)::numeric AS amount,
                kwh AS units,
                CASE WHEN kwh > 0 THEN 'paid' ELSE 'due' END AS status
            FROM (
                SELECT
                    date_trunc('month', timestamp) AS month,
                    COALESCE(MAX(energy_consumed) - MIN(energy_consumed), 0) AS kwh
                FROM "EnergyReadings"
                WHERE user_id = $1::text
                GROUP BY 1
                ORDER BY 1 DESC
                LIMIT 12
            ) sub;
        `;

        const result = await pool.query(historyQuery, [userId]);
        return res.json({ success: true, bills: result.rows });
    } catch (err) {
        console.error('❌ Error fetching billing history:', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

// ============ BILLING SERVICE ENDPOINTS (Enhanced with BillingService) ============

/**
 * GET /api/billing/calculate/:userId
 * Calculate current month's bill with complete breakdown
 * Query params: baseCharge (default 50), ratePerKwh (default 10)
 */
app.get('/api/billing/calculate/:userId', async (req, res) => {
    try {
        const { userId } = req.params;
        const { baseCharge = 50, ratePerKwh = 10 } = req.query;
        
        const bill = await BillingService.calculateCurrentBill(
            userId,
            parseFloat(baseCharge),
            parseFloat(ratePerKwh)
        );
        
        return res.json({ 
            success: true, 
            ...bill
        });
    } catch (err) {
        console.error('❌ Error calculating current bill:', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

/**
 * GET /api/billing/predict/:userId
 * Predict monthly bill based on current consumption
 * Query params: ratePerKwh (default 10), baseCharge (default 50)
 */
app.get('/api/billing/predict/:userId', async (req, res) => {
    try {
        const { userId } = req.params;
        const { ratePerKwh = 10, baseCharge = 50 } = req.query;
        
        const currentKwh = await BillingService.getCurrentMonthUsage(userId);
        const daysElapsed = BillingService.getDaysElapsed();
        
        const projection = BillingService.predictMonthlyBill(
            currentKwh,
            daysElapsed,
            parseFloat(ratePerKwh),
            parseFloat(baseCharge)
        );
        
        return res.json({ 
            success: true,
            user_id: userId,
            ...projection
        });
    } catch (err) {
        console.error('❌ Error predicting bill:', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

/**
 * GET /api/billing/history/:userId
 * Get historical bills for past 6 months
 * Query params: monthsBack (default 6), baseCharge (default 50), ratePerKwh (default 10)
 */
app.get('/api/billing/detailed-history/:userId', async (req, res) => {
    try {
        const { userId } = req.params;
        const { monthsBack = 6, baseCharge = 50, ratePerKwh = 10 } = req.query;
        
        const history = await BillingService.getHistoricalBills(
            userId,
            parseInt(monthsBack),
            parseFloat(baseCharge),
            parseFloat(ratePerKwh)
        );
        
        return res.json({ 
            success: true,
            user_id: userId,
            months: parseInt(monthsBack),
            bills: history
        });
    } catch (err) {
        console.error('❌ Error fetching detailed history:', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

/**
 * GET /api/billing/summary/:userId
 * Get comprehensive billing summary (current + projection + comparison)
 * Query params: baseCharge (default 50), ratePerKwh (default 10)
 */
app.get('/api/billing/summary/:userId', async (req, res) => {
    try {
        const { userId } = req.params;
        const { baseCharge = 50, ratePerKwh = 10 } = req.query;
        
        const summary = await BillingService.getBillingSummary(
            userId,
            parseFloat(baseCharge),
            parseFloat(ratePerKwh)
        );
        
        return res.json({ 
            success: true,
            ...summary
        });
    } catch (err) {
        console.error('❌ Error generating billing summary:', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

// ============ PUSH NOTIFICATION ENDPOINTS ============

/**
 * POST /api/notifications/register-fcm
 * Register or update user's FCM token for push notifications
 */
app.post('/api/notifications/register-fcm', async (req, res) => {
  try {
    const { userId, fcmToken } = req.body;

    if (!userId || !fcmToken) {
      return res.status(400).json({ success: false, error: 'Missing userId or fcmToken' });
    }

    const result = await PushNotificationService.updateFCMToken(userId, fcmToken);
    res.json(result);
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/notifications/register-mobile
 * Register or update user's mobile number
 */
app.post('/api/notifications/register-mobile', async (req, res) => {
  try {
    const { userId, mobileNumber } = req.body;

    if (!userId || !mobileNumber) {
      return res.status(400).json({ success: false, error: 'Missing userId or mobileNumber' });
    }

    const result = await PushNotificationService.updateMobileNumber(userId, mobileNumber);
    res.json(result);
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/notifications/push-history/:userId
 * Get push notification history for a user
 */
app.get('/api/notifications/push-history/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    const { limit = 20 } = req.query;

    const result = await PushNotificationService.getNotificationHistory(userId, parseInt(limit));
    res.json(result);
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/notifications/test-push
 * Send test push notification to verify setup
 */
app.post('/api/notifications/test-push', async (req, res) => {
  try {
    const { userId } = req.body;

    if (!userId) {
      return res.status(400).json({ success: false, error: 'Missing userId' });
    }

    const testData = {
      currentPower: 250,
      threshold: 150,
      anomalySocket: 'Socket 1',
      message: 'Test push notification from WattBuddy - System working correctly!',
    };

    const result = await PushNotificationService.sendAnomalyAlert(userId, testData);
    res.json(result);
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ============ POWER-LIMIT ENDPOINTS ============
app.post('/api/power-limit/check', async (req, res) => {
  try {
    const { userId, currentUsage, dailyLimit } = req.body;
    const notification = await PowerLimitService.checkPowerLimit(userId, currentUsage, dailyLimit);
    res.json({ success: true, ...notification });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/power-limit/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    const settings = await PowerLimitService.getPowerLimitSettings(userId);
    res.json({ success: true, ...settings });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============ GRAPH ENDPOINTS ============
app.get('/api/graph/live/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    const { minutes = 60 } = req.query;
    const data = await RealtimeGraphService.getLiveGraphData(userId, minutes);
    res.json({ success: true, graphData: data });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============ DEBUG: recent energy rows (no psql needed) ============
app.get('/api/debug/recent-energy', async (req, res) => {
  try {
    const pool = require('./db');
    const limit = parseInt(req.query.limit) || 20;

    // Prefer canonical snake_case table used by graph service
    try {
      const result = await pool.query(
        `SELECT recorded_at as timestamp, power_consumption as power, voltage, current
         FROM energy_readings
         ORDER BY recorded_at DESC
         LIMIT $1`,
        [limit]
      );

      return res.json({ success: true, source: 'energy_readings', rows: result.rows });
    } catch (e) {
      // Fallback to older "EnergyReadings" table
      const fallback = await pool.query(
        `SELECT timestamp as timestamp, power as power, voltage, current
         FROM "EnergyReadings"
         ORDER BY timestamp DESC
         LIMIT $1`,
        [limit]
      );
      return res.json({ success: true, source: 'EnergyReadings', rows: fallback.rows });
    }
  } catch (err) {
    console.error('❌ Debug recent-energy failed:', err);
    res.status(500).json({ success: false, error: err.message || err });
  }
});

// ============ ML PREDICTION ENDPOINTS ============
app.get('/api/ml-predict/next-hour/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    const prediction = await MLPredictionService.predictNextHour(userId);
    res.json({ success: true, prediction });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============ RELAY CONTROL ENDPOINTS ============
// Helper function to send command to ESP32
async function sendRelayCommandToESP32(relayNumber, command) {
  const url = `http://${ESP32_IP}:${ESP32_PORT}/relay${relayNumber}/${command}`;
  console.log(`📡 Sending relay command to ESP32: ${url}`);
  
  try {
    const response = await axios.get(url, { timeout: 5000 });
    console.log(`✅ ESP32 responded: ${response.status} - ${response.data}`);
    return { success: true, esp32Response: response.data };
  } catch (error) {
    console.error(`❌ Failed to communicate with ESP32: ${error.message}`);
    return { success: false, error: error.message };
  }
}

// Turn off Socket 1 relay
app.get('/api/relay/relay1/off', async (req, res) => {
  try {
    console.log('🔴 [RELAY 1 OFF] User triggered shutdown');
    
    // Send actual command to ESP32
    const esp32Result = await sendRelayCommandToESP32(1, 'off');
    
    // Emit relay status update to all connected clients
    io.emit('relay_status', {
      relay: 1,
      status: 'off',
      message: esp32Result.success ? 'Socket 1 has been safely disconnected' : 'Failed to disconnect Socket 1',
      esp32Connected: esp32Result.success,
      timestamp: new Date().toISOString()
    });
    
    // Update cache
    esp32LatestData.relay1 = 0;
    
    if (esp32Result.success) {
      res.json({ 
        success: true, 
        message: 'Socket 1 relay turned OFF',
        relay: 1,
        status: 'off'
      });
    } else {
      res.status(500).json({ 
        success: false, 
        error: 'Failed to connect to ESP32: ' + esp32Result.error,
        message: 'Could not reach ESP32 device. Is it connected to the network?'
      });
    }
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Turn off Socket 2 relay
app.get('/api/relay/relay2/off', async (req, res) => {
  try {
    console.log('🔴 [RELAY 2 OFF] User triggered shutdown');
    
    // Send actual command to ESP32
    const esp32Result = await sendRelayCommandToESP32(2, 'off');
    
    // Emit relay status update to all connected clients
    io.emit('relay_status', {
      relay: 2,
      status: 'off',
      message: esp32Result.success ? 'Socket 2 has been safely disconnected' : 'Failed to disconnect Socket 2',
      esp32Connected: esp32Result.success,
      timestamp: new Date().toISOString()
    });
    
    // Update cache
    esp32LatestData.relay2 = 0;
    
    if (esp32Result.success) {
      res.json({ 
        success: true, 
        message: 'Socket 2 relay turned OFF',
        relay: 2,
        status: 'off'
      });
    } else {
      res.status(500).json({ 
        success: false, 
        error: 'Failed to connect to ESP32: ' + esp32Result.error,
        message: 'Could not reach ESP32 device. Is it connected to the network?'
      });
    }
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Turn on Socket 1 relay
app.get('/api/relay/relay1/on', async (req, res) => {
  try {
    console.log('🟢 [RELAY 1 ON] User enabled socket');
    
    // Send actual command to ESP32
    const esp32Result = await sendRelayCommandToESP32(1, 'on');
    
    io.emit('relay_status', {
      relay: 1,
      status: 'on',
      message: esp32Result.success ? 'Socket 1 has been re-enabled' : 'Failed to enable Socket 1',
      esp32Connected: esp32Result.success,
      timestamp: new Date().toISOString()
    });
    
    // Update cache
    esp32LatestData.relay1 = 1;
    
    if (esp32Result.success) {
      res.json({ 
        success: true, 
        message: 'Socket 1 relay turned ON',
        relay: 1,
        status: 'on'
      });
    } else {
      res.status(500).json({ 
        success: false, 
        error: 'Failed to connect to ESP32: ' + esp32Result.error,
        message: 'Could not reach ESP32 device. Is it connected to the network?'
      });
    }
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Turn on Socket 2 relay
app.get('/api/relay/relay2/on', async (req, res) => {
  try {
    console.log('🟢 [RELAY 2 ON] User enabled socket');
    
    // Send actual command to ESP32
    const esp32Result = await sendRelayCommandToESP32(2, 'on');
    
    io.emit('relay_status', {
      relay: 2,
      status: 'on',
      message: esp32Result.success ? 'Socket 2 has been re-enabled' : 'Failed to enable Socket 2',
      esp32Connected: esp32Result.success,
      timestamp: new Date().toISOString()
    });
    
    // Update cache
    esp32LatestData.relay2 = 1;
    
    if (esp32Result.success) {
      res.json({ 
        success: true, 
        message: 'Socket 2 relay turned ON',
        relay: 2,
        status: 'on'
      });
    } else {
      res.status(500).json({ 
        success: false, 
        error: 'Failed to connect to ESP32: ' + esp32Result.error,
        message: 'Could not reach ESP32 device. Is it connected to the network?'
      });
    }
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get current relay status
app.get('/api/relay/status', (req, res) => {
  try {
    res.json({
      success: true,
      relay1: esp32LatestData.relay1,
      relay2: esp32LatestData.relay2,
      timestamp: esp32LatestData.timestamp
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============ DAILY USAGE MANAGEMENT ENDPOINTS ============
// Backfill daily_usage table from historical EnergyReadings
app.post('/api/usage/backfill/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    const { daysBack } = req.body;
    
    const days = parseInt(daysBack) || 90; // Default 90 days
    
    console.log(`🔄 Starting backfill for user ${userId}, ${days} days...`);
    const result = await DailyAnalyticsService.backfillDailyUsage(userId, days);
    
    res.json({
      success: true,
      message: `Backfilled ${result.length} days of usage data`,
      daysBackfilled: result.length,
      data: result
    });
  } catch (error) {
    console.error('❌ Backfill error:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

// Get user baseline statistics
app.get('/api/usage/baseline/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    const baseline = await DailyAnalyticsService.getUserBaseline(userId);
    
    res.json({
      success: true,
      baseline
    });
  } catch (error) {
    console.error('❌ Baseline fetch error:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

// Manually trigger daily aggregation for today
app.post('/api/usage/aggregate-today/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    const result = await DailyAnalyticsService.aggregateDailyUsage(userId);
    
    res.json({
      success: true,
      message: 'Daily usage aggregated for today',
      data: result
    });
  } catch (error) {
    console.error('❌ Aggregation error:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

// ============ SOCKET.IO LOGIC ============
io.on('connection', (socket) => {
  console.log(`✅ Dashboard Connected: ${socket.id}`);

  // Send the most recent data immediately upon connection
  socket.emit('live_data_update', esp32LatestData);

  socket.on('disconnect', () => {
    console.log('🔌 Dashboard Disconnected');
  });
});

// ============ DEBUG: FORCE ANOMALY ALERT (for Flutter testing) ============
// Hit this in a browser: http://localhost:4000/api/debug/trigger-anomaly
// You should see an alert in the app if Socket.io + handlers are wired.
app.get('/api/debug/trigger-anomaly', (req, res) => {
  try {
    const payload = {
      isAbnormal: true,
      anomalySocket: 'Socket 1',
      currentPower: 250,
      threshold: 150,
      dominantRelay: 1,
      dominantPower: 250,
      message: '⚠️ Test high usage on Socket 1 (debug endpoint)',
      timestamp: new Date().toISOString(),
      userId: 'debug',
    };
    io.emit('anomaly_alert', payload);
    console.log('🧪 [DEBUG] Emitted test anomaly_alert:', payload);
    res.json({ success: true, emitted: payload });
  } catch (e) {
    console.error('❌ Failed to emit debug anomaly:', e);
    res.status(500).json({ success: false, error: e.message || String(e) });
  }
});

// ============ ALERT DISMISSAL ENDPOINT (Smart Dismissal) ============
app.post('/api/alerts/dismiss/:alertId', async (req, res) => {
  try {
    const { alertId } = req.params;
    const { userId, alertData } = req.body;

    if (!alertId || !userId) {
      return res.status(400).json({ success: false, error: 'Missing alertId or userId' });
    }

    // Record dismissal with 2-minute re-alert scheduling
    const now = new Date();
    const reAlertTime = new Date(now.getTime() + 2 * 60 * 1000); // 2 minutes from now

    const pool = require('./db');
    
    // Store in database
    await pool.query(
      `INSERT INTO alert_dismissals (user_id, alert_id, alert_data, dismissed_at, re_alert_scheduled_for)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (alert_id) DO UPDATE SET dismissed_at=$4, re_alert_scheduled_for=$5, re_alerted=FALSE`,
      [userId, alertId, JSON.stringify(alertData || {}), now, reAlertTime]
    );

    // Store in in-memory cache for fast lookups
    dismissedAlerts[alertId] = {
      userId,
      dismissedAt: now,
      originalData: alertData || {},
      reAlertScheduledFor: reAlertTime
    };

    // Emit dismissal event to all clients
    io.emit('alert_dismissed', { alertId, userId, reAlertIn: '2 minutes' });

    console.log(`📝 Alert ${alertId} dismissed by user ${userId}. Will re-alert in 2 minutes if power still high.`);

    res.json({
      success: true,
      message: 'Alert dismissed. Will re-alert in 2 minutes if power usage remains high.',
      reAlertIn: '2 minutes',
      reAlertScheduledFor: reAlertTime
    });
  } catch (error) {
    console.error('❌ Alert dismissal failed:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ============ PATTERN ANALYSIS ENDPOINTS ============
// Get learned socket power signatures
app.get('/api/relay/signatures/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    const signatures = await PatternAnalysisService.getSocketSignatures(userId);

    res.json({
      success: true,
      signatures: signatures || { socket1: {}, socket2: {} },
      message: signatures ? 'Socket signatures learned from relay toggles' : 'Insufficient toggle data to learn signatures'
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Manually trigger pattern analysis
app.post('/api/pattern/analyze/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    const patterns = await PatternAnalysisService.analyzeConsumptionPatterns(userId);

    res.json({
      success: true,
      patterns: patterns || [],
      message: patterns ? `Analyzed ${patterns.length} hour/day patterns` : 'Insufficient history for pattern analysis'
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ============ MONTHLY BILLING RESET (CRON JOB) ============
cron.schedule('0 0 1 * *', async () => {
        
        // Create monthly snapshots for all users
        console.log('📸 Creating monthly energy snapshots for all users...');
        const snapshotResults = await MonthlySnapshotService.createMonthlySnapshots();
        console.log(`✅ Created ${snapshotResults.created} snapshots, reused ${snapshotResults.existing} existing.`);
    try {
        const pool = require('./db');
        console.log('📅 Running Monthly Billing Reset...');
        await pool.query('SELECT reset_monthly_bill();');
        console.log('✅ Monthly billing snapshots saved and reset.');
    } catch (err) {
        console.error('❌ Monthly reset failed:', err);
    }
});

// ============ DAILY USAGE AGGREGATION (CRON JOB - Runs at midnight) ============
cron.schedule('0 0 * * *', async () => {
    try {
        console.log('📊 Running Daily Usage Aggregation...');
        
        // Get all users with data
        const pool = require('./db');
        const usersResult = await pool.query(`
            SELECT DISTINCT user_id 
            FROM "EnergyReadings" 
            WHERE timestamp >= CURRENT_DATE - INTERVAL '1 day'
        `);
        
        // Aggregate for each user
        for (const row of usersResult.rows) {
            const yesterday = moment().subtract(1, 'day').format('YYYY-MM-DD');
            await DailyAnalyticsService.aggregateDailyUsage(row.user_id, yesterday);

            // Finalize carry-forward and award reward for closed day if rollover happened.
            const resetResult = await GoalTrackingService.checkAndResetDaily(row.user_id);
            if (resetResult && resetResult.resetNeeded && resetResult.previousDate) {
              await RewardSystemService.calculateDailyPoints(row.user_id, resetResult.previousDate);
            }
        }
        
        console.log(`✅ Daily usage aggregated for ${usersResult.rows.length} users`);
    } catch (err) {
        console.error('❌ Daily aggregation failed:', err);
    }
});

// ============ RE-ALERT CHECK (CRON JOB - Every minute) ============
cron.schedule('*/1 * * * *', async () => {
  try {
    const pool = require('./db');
    const now = new Date();

    // Get all dismissed alerts that are ready for re-alerting
    const result = await pool.query(
      `SELECT * FROM alert_dismissals 
       WHERE re_alert_scheduled_for <= $1 AND re_alerted = FALSE`,
      [now]
    );

    for (const dismissal of result.rows) {
      try {
        const userId = dismissal.user_id;
        const alertId = dismissal.alert_id;
        const originalData = dismissal.alert_data;

        // Check current power from latest ESP32 data
        const latestReading = await pool.query(
          `SELECT power FROM "EnergyReadings" 
           WHERE user_id = $1 
           ORDER BY timestamp DESC LIMIT 1`,
          [userId]
        );

        if (latestReading.rows.length > 0) {
          const currentPower = latestReading.rows[0].power;
          const baseline = await DailyAnalyticsService.getUserBaseline(userId);

          // Re-alert threshold: if power is still above threshold
          if (currentPower > (baseline.threshold || 150)) {
            console.log(`🔔 [RE-ALERT] User ${userId}: Power ${currentPower.toFixed(0)}W still above threshold ${(baseline.threshold || 150).toFixed(0)}W. Re-alerting...`);

            const reAlertData = {
              ...originalData,
              alertId,
              isReAlert: true,
              reAlertedAt: now.toISOString(),
              currentPower,
              threshold: baseline.threshold || 150
            };

            // Emit re-alert
            io.emit('anomaly_alert', reAlertData);

            // Send push notification
            PushNotificationService.sendAnomalyAlert(userId, {
              ...reAlertData,
              message: `⚠️ RE-ALERT: ${originalData.anomalySocket} power is STILL ${currentPower.toFixed(0)}W! Please check.`
            }).catch(err => console.error('❌ Re-alert push failed:', err));

            // Mark as re-alerted in database
            await pool.query(
              `UPDATE alert_dismissals SET re_alerted = TRUE, re_alert_sent_at = $1 WHERE alert_id = $2`,
              [now, alertId]
            );

            // Remove from in-memory cache
            delete dismissedAlerts[alertId];
          } else {
            console.log(`✅ [NO RE-ALERT] User ${userId}: Power dropped to ${currentPower.toFixed(0)}W. Dismissal stands.`);

            // Clear the dismissal if power is back to normal
            await pool.query(
              `UPDATE alert_dismissals SET re_alerted = TRUE WHERE alert_id = $1`,
              [alertId]
            );
            delete dismissedAlerts[alertId];
          }
        }
      } catch (itemErr) {
        console.error(`❌ Re-alert processing failed for alert ${dismissal.alert_id}:`, itemErr);
      }
    }
  } catch (err) {
    console.error('❌ Re-alert check failed:', err);
  }
});

// Ensure supporting tables exist (safe to run every start)
try {
  const pool = require('./db');
  (async () => {
    try {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS "UserStats" (
          user_id TEXT PRIMARY KEY,
          total_energy NUMERIC DEFAULT 0,
          created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
          updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
        );
      `);

      // Backward-compatible migration for existing databases.
      await pool.query(`
        ALTER TABLE users
        ADD COLUMN IF NOT EXISTS mobile_number VARCHAR(15)
      `);
      console.log('✅ Ensured table "UserStats" exists');
      console.log('✅ Ensured column users.mobile_number exists');
    } catch (e) {
      console.error('❌ Error ensuring UserStats table exists:', e);
    }
  })();
} catch (e) {
  console.error('❌ Could not initialize DB helper for migrations:', e);
}

// ============ START SERVER ============
const PORT = process.env.PORT || 4000;
server.listen(PORT, '0.0.0.0', () => {
  console.log('\n🚀 ================================');
  console.log('   WattBuddy Server: ONLINE');
  console.log('================================');
  console.log(`🌐 Listening at: http://0.0.0.0:${PORT}`);
  console.log('📱 Waiting for data from Flutter App...');
  console.log('================================\n');
});

module.exports = { app, server, io, esp32LatestData };

