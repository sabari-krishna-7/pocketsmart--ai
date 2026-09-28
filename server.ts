import express, { Request, Response } from 'express';
import path from 'path';
import dotenv from 'dotenv';
import { RecommendationEngine } from './src/services/recommendationEngine';
import { GeminiService } from './src/services/geminiService';
import {
  HomePlannerInput,
  PartyPlannerInput,
  JewelryPlannerInput,
  PlanRecommendation,
  UserSession,
} from './src/types';

dotenv.config();

const app = express();
const PORT = 3000;

// Allow body payloads up to 10MB for base64 outfit images
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// In-memory data store for sessions and plan history (simulates SQLite DB)
const plansHistory: PlanRecommendation[] = [];
let currentSessionUser: UserSession = {
  userId: 'usr-demo-01',
  email: 'planner@pocketsmart.ai',
  displayName: 'Smart Planner',
  createdAt: new Date().toISOString(),
};

// -------------------------------------------------------------
// Health Check Endpoint (Milestone 5)
// -------------------------------------------------------------
const getHealthPayload = () => ({
  status: 'ok',
  appName: 'PocketSmart AI',
  aiConfigured: GeminiService.isConfigured(),
  model: process.env.GEMINI_MODEL || 'gemini-3.8-flash',
  timestamp: new Date().toISOString(),
});

app.get('/health', (req: Request, res: Response) => {
  res.json(getHealthPayload());
});

app.get('/api/health', (req: Request, res: Response) => {
  res.json(getHealthPayload());
});

// -------------------------------------------------------------
// Authentication & Session Endpoints
// -------------------------------------------------------------
const getSessionPayload = () => ({
  authenticated: currentSessionUser.userId !== 'guest',
  user: currentSessionUser,
  session_metadata: {
    userId: currentSessionUser.userId,
    email: currentSessionUser.email,
    displayName: currentSessionUser.displayName,
    role: 'planner',
    activeSince: currentSessionUser.createdAt,
  },
});

app.get(['/api/auth/session', '/session-info', '/session-data', '/api/session-info', '/api/session-data'], (req: Request, res: Response) => {
  res.json(getSessionPayload());
});

app.post(['/api/auth/login', '/login', '/api/login'], (req: Request, res: Response) => {
  const { email, displayName } = req.body;
  if (email) {
    currentSessionUser = {
      userId: `usr-${Date.now()}`,
      email,
      displayName: displayName || email.split('@')[0],
      createdAt: new Date().toISOString(),
    };
  }
  res.json({
    success: true,
    user: currentSessionUser,
    token: `token-${currentSessionUser.userId}`,
  });
});

app.post(['/api/auth/register', '/register', '/api/register'], (req: Request, res: Response) => {
  const { email, displayName } = req.body;
  const userEmail = email || `user_${Date.now()}@pocketsmart.ai`;
  currentSessionUser = {
    userId: `usr-${Date.now()}`,
    email: userEmail,
    displayName: displayName || userEmail.split('@')[0],
    createdAt: new Date().toISOString(),
  };
  res.json({
    success: true,
    user: currentSessionUser,
    token: `token-${currentSessionUser.userId}`,
  });
});

app.post(['/api/auth/logout', '/logout', '/api/logout'], (req: Request, res: Response) => {
  currentSessionUser = {
    userId: 'guest',
    email: 'guest@pocketsmart.ai',
    displayName: 'Guest User',
    createdAt: new Date().toISOString(),
  };
  res.json({ success: true, user: currentSessionUser });
});

app.get(['/token', '/api/token'], (req: Request, res: Response) => {
  res.json({
    access_token: `token-${currentSessionUser.userId}`,
    token_type: 'bearer',
    user: currentSessionUser,
  });
});

// -------------------------------------------------------------
// Home Interior Planner Endpoint
// -------------------------------------------------------------
app.post(['/generate-home', '/api/generate-home'], async (req: Request, res: Response) => {
  try {
    const input: HomePlannerInput = req.body;

    if (!input.rooms || input.rooms.length === 0) {
      return res.status(400).json({ error: 'Please select at least one room.' });
    }
    if (!input.totalBudget || input.totalBudget <= 0) {
      return res.status(400).json({ error: 'Please enter a valid budget amount.' });
    }

    // 1. Generate deterministic budget allocations and catalog matches
    const plan = RecommendationEngine.generateHomePlan(input);

    // 2. Enhance with Gemini AI analysis if configured
    if (GeminiService.isConfigured()) {
      try {
        const aiResult = await GeminiService.analyzeHomeInterior({
          rooms: input.rooms.map((r) => ({
            roomType: r.roomType,
            items: r.items.map((i) => ({ name: i.name, quantity: i.quantity })),
          })),
          totalBudget: input.totalBudget,
          stylePreference: input.stylePreference,
          notes: input.notes,
          enableHighThinking: input.enableHighThinking,
        });

        if (aiResult) {
          plan.aiAnalysis = {
            overview: aiResult.overview || plan.aiAnalysis?.overview || '',
            stylingAdvice: aiResult.stylingAdvice?.length ? aiResult.stylingAdvice : plan.aiAnalysis?.stylingAdvice || [],
            costSavingTips: aiResult.costSavingTips?.length ? aiResult.costSavingTips : plan.aiAnalysis?.costSavingTips || [],
            warnings: aiResult.warnings,
            thinkingInsights: aiResult.thinkingInsights,
          };
        }
      } catch (aiErr) {
        console.warn('AI analysis skipped gracefully due to transient API condition:', aiErr);
      }
    }

    // Save to history
    plansHistory.unshift(plan);

    return res.json(plan);
  } catch (error: any) {
    console.error('Error generating home plan:', error);
    return res.status(500).json({ error: error.message || 'Internal server error' });
  }
});

// -------------------------------------------------------------
// Party Planner Endpoint
// -------------------------------------------------------------
app.post(['/generate-party', '/api/generate-party'], async (req: Request, res: Response) => {
  try {
    const input: PartyPlannerInput = req.body;

    if (!input.eventType) {
      return res.status(400).json({ error: 'Event type is required.' });
    }
    if (!input.guestCount || input.guestCount <= 0) {
      return res.status(400).json({ error: 'Please enter a valid guest count.' });
    }
    if (!input.totalBudget || input.totalBudget <= 0) {
      return res.status(400).json({ error: 'Please enter a valid budget.' });
    }

    // 1. Generate deterministic proportional breakdown
    const plan = RecommendationEngine.generatePartyPlan(input);

    // 2. Enhance with Gemini AI analysis
    if (GeminiService.isConfigured()) {
      try {
        const aiResult = await GeminiService.analyzePartyPlan({
          eventType: input.eventType,
          guestCount: input.guestCount,
          city: input.city,
          venueType: input.venueType,
          totalBudget: input.totalBudget,
          dietaryPreference: input.dietaryPreference,
          themeNotes: input.themeNotes,
          enableHighThinking: input.enableHighThinking,
        });

        if (aiResult) {
          plan.aiAnalysis = {
            overview: aiResult.overview || plan.aiAnalysis?.overview || '',
            stylingAdvice: aiResult.stylingAdvice?.length ? aiResult.stylingAdvice : plan.aiAnalysis?.stylingAdvice || [],
            costSavingTips: aiResult.costSavingTips?.length ? aiResult.costSavingTips : plan.aiAnalysis?.costSavingTips || [],
            warnings: aiResult.warnings,
            thinkingInsights: aiResult.thinkingInsights,
          };
        }
      } catch (aiErr) {
        console.warn('Party AI analysis skipped gracefully:', aiErr);
      }
    }

    plansHistory.unshift(plan);
    return res.json(plan);
  } catch (error: any) {
    console.error('Error generating party plan:', error);
    return res.status(500).json({ error: error.message || 'Internal server error' });
  }
});

// -------------------------------------------------------------
// Jewelry Planner Endpoint
// -------------------------------------------------------------
app.post(['/generate-jewelry', '/api/generate-jewelry'], async (req: Request, res: Response) => {
  try {
    const input: JewelryPlannerInput = req.body;

    if (!input.jewelryPieces || input.jewelryPieces.length === 0) {
      return res.status(400).json({ error: 'Please select at least one jewelry piece.' });
    }
    if (!input.totalBudget || input.totalBudget <= 0) {
      return res.status(400).json({ error: 'Please enter a valid budget amount.' });
    }

    // Check optional image payload size (enforce MAX_UPLOAD_MB = 5)
    if (input.imagePayload?.base64Data) {
      const approxBytes = (input.imagePayload.base64Data.length * 3) / 4;
      const sizeMB = approxBytes / (1024 * 1024);
      if (sizeMB > 5) {
        return res.status(400).json({ error: 'Uploaded outfit image exceeds 5MB limit.' });
      }
    }

    // 1. Generate deterministic jewelry plan
    const plan = RecommendationEngine.generateJewelryPlan(input);

    // 2. Enhance with Gemini AI analysis
    if (GeminiService.isConfigured()) {
      try {
        const aiResult = await GeminiService.analyzeJewelryPlan({
          occasion: input.occasion,
          stylePreference: input.stylePreference,
          outfitColor: input.outfitColor,
          outfitType: input.outfitType,
          totalBudget: input.totalBudget,
          jewelryPieces: input.jewelryPieces,
          metalPreference: input.metalPreference,
          imagePayload: input.imagePayload,
          enableHighThinking: input.enableHighThinking,
        });

        if (aiResult) {
          plan.aiAnalysis = {
            overview: aiResult.overview || plan.aiAnalysis?.overview || '',
            stylingAdvice: aiResult.stylingAdvice?.length ? aiResult.stylingAdvice : plan.aiAnalysis?.stylingAdvice || [],
            costSavingTips: aiResult.costSavingTips?.length ? aiResult.costSavingTips : plan.aiAnalysis?.costSavingTips || [],
            warnings: aiResult.warnings,
            thinkingInsights: aiResult.thinkingInsights,
          };
        }
      } catch (aiErr) {
        console.warn('Jewelry AI analysis skipped gracefully:', aiErr);
      }
    }

    plansHistory.unshift(plan);
    return res.json(plan);
  } catch (error: any) {
    console.error('Error generating jewelry plan:', error);
    return res.status(500).json({ error: error.message || 'Internal server error' });
  }
});

// -------------------------------------------------------------
// History & Details Endpoints
// -------------------------------------------------------------
app.get(['/history', '/api/history'], (req: Request, res: Response) => {
  res.json({
    history: plansHistory,
    totalCount: plansHistory.length,
  });
});

app.get(['/recommendations-details/:id', '/api/recommendations-details/:id'], (req: Request, res: Response) => {
  const { id } = req.params;
  const found = plansHistory.find((p) => p.id === id);
  if (!found) {
    return res.status(404).json({ error: 'Plan not found.' });
  }
  return res.json(found);
});

// -------------------------------------------------------------
// Static / Vite Middleware Setup
// -------------------------------------------------------------
async function startServer() {
  if (process.env.NODE_ENV === 'production') {
    app.use(express.static(path.resolve(process.cwd(), 'dist')));
    app.get('*', (req: Request, res: Response) => {
      res.sendFile(path.resolve(process.cwd(), 'dist', 'index.html'));
    });
  } else {
    const { createServer } = await import('vite');
    const vite = await createServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`PocketSmart AI server running on http://0.0.0.0:${PORT}`);
  });
}

startServer();
