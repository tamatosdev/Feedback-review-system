const { GoogleGenAI } = require('@google/genai');

// gemini-2.5-flash is deprecated for new accounts; defaults to a newer model.
// Override with GEMINI_MODEL in .env if needed.
const MODEL = process.env.GEMINI_MODEL || 'gemini-3.6-flash';

// Old submissions (single rating only) have null department scores.
function fmtScore(value) {
  return Number.isInteger(value) && value >= 1 && value <= 5 ? `${value}/5` : 'n/a';
}

function departmentScoresLine(data) {
  return [
    `Account Management: ${fmtScore(data.accountManagementScore)}`,
    `Strategy: ${fmtScore(data.strategyScore)}`,
    `Creative: ${fmtScore(data.creativeScore)}`,
    `Design & Content Production: ${fmtScore(data.designContentScore)}`,
    `Social & Content: ${fmtScore(data.socialContentScore)}`,
    `Agency Leadership (Overall): ${fmtScore(data.agencyLeadershipScore)}`
  ].join('\n');
}

const PROMPT_TEMPLATE = (data) => `You are a client feedback analyst. Analyze the following client feedback and return STRICTLY valid JSON with exactly these keys and no other text, no markdown fences, no explanation:

{
  "sentiment": "Positive | Neutral | Negative",
  "summary": "2-3 sentence summary",
  "highlights": ["point 1", "point 2"],
  "improvementSuggestions": ["point 1", "point 2"],
  "urgency": "Low | Medium | High"
}

Feedback:
Project Name / Service Name: ${data.eventName}
Overall Rating: ${data.rating}/5
Department Ratings:
${departmentScoresLine(data)}
Client Feedback/Comments: ${data.comments}
Suggestions/Recommendations: ${data.suggestions}`;

function ratingFallback(rating) {
  if (rating >= 4) return 'Positive';
  if (rating === 3) return 'Neutral';
  return 'Negative';
}

function urgencyFallback(sentiment) {
  if (sentiment === 'Negative') return 'High';
  if (sentiment === 'Neutral') return 'Medium';
  return 'Low';
}

function fallbackAnalysis(data) {
  const sentiment = ratingFallback(data.rating);
  return {
    sentiment,
    summary: `This feedback received a ${data.rating}/5 rating. ${data.comments}`,
    highlights: [data.comments],
    improvementSuggestions: [data.suggestions === 'No suggestions provided'
      ? 'No AI suggestions available.'
      : data.suggestions],
    urgency: urgencyFallback(sentiment)
  };
}

function parseGeminiJson(text) {
  if (!text) return null;
  let cleaned = String(text).trim();
  const fence = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) cleaned = fence[1].trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    return JSON.parse(cleaned.slice(start, end + 1));
  } catch {
    return null;
  }
}

function normalizeAnalysis(parsed, data) {
  const fb = fallbackAnalysis(data);
  const sentiment = ['Positive', 'Neutral', 'Negative'].includes(parsed?.sentiment)
    ? parsed.sentiment
    : fb.sentiment;
  return {
    sentiment,
    summary: typeof parsed?.summary === 'string' && parsed.summary.trim()
      ? parsed.summary.trim()
      : fb.summary,
    highlights: Array.isArray(parsed?.highlights)
      ? parsed.highlights.filter((h) => typeof h === 'string' && h.trim()).slice(0, 5)
      : fb.highlights,
    improvementSuggestions: Array.isArray(parsed?.improvementSuggestions)
      ? parsed.improvementSuggestions.filter((h) => typeof h === 'string' && h.trim()).slice(0, 5)
      : fb.improvementSuggestions,
    urgency: ['Low', 'Medium', 'High'].includes(parsed?.urgency)
      ? parsed.urgency
      : urgencyFallback(sentiment)
  };
}

function sentimentColor(sentiment) {
  if (sentiment === 'Positive') return { badge: '#16a34a', bg: '#dcfce7' };
  if (sentiment === 'Neutral') return { badge: '#ea580c', bg: '#ffedd5' };
  return { badge: '#dc2626', bg: '#fee2e2' };
}

async function analyzeFeedback(data, { apiKey } = {}) {
  if (!apiKey) return { analysis: fallbackAnalysis(data), usedAi: false };

  try {
    const genAI = new GoogleGenAI({ apiKey });
    const result = await genAI.models.generateContent({
      model: MODEL,
      contents: PROMPT_TEMPLATE(data),
      config: {
        temperature: 0.4,
        responseMimeType: 'application/json'
      }
    });
    const text = result.text;
    const parsed = parseGeminiJson(text);
    return { analysis: normalizeAnalysis(parsed, data), usedAi: true };
  } catch (err) {
    console.error('[Gemini] analysis failed, using fallback:', err.message);
    return { analysis: fallbackAnalysis(data), usedAi: false };
  }
}

async function analyzeCombined(feedbackRows, { apiKey } = {}) {
  const input = feedbackRows
    .map((f, i) => {
      const scores = f.agencyLeadershipScore != null
        ? ` | Department Scores: AM ${fmtScore(f.accountManagementScore)}, ST ${fmtScore(f.strategyScore)}, CR ${fmtScore(f.creativeScore)}, DC ${fmtScore(f.designContentScore)}, SC ${fmtScore(f.socialContentScore)}, AL ${fmtScore(f.agencyLeadershipScore)}`
        : '';
      return `#${i + 1} Project/Service: ${f.eventName} | Overall Rating: ${f.rating}/5${scores} | Client Feedback: ${f.comments} | Suggestions: ${f.suggestions}`;
    })
    .join('\n');

  const prompt = `You are a client analytics analyst. Analyze the following batch of ${feedbackRows.length} client feedback submissions. Return STRICTLY valid JSON with exactly these keys and no other text, no markdown, no explanation:

{
  "overallSentimentBreakdown": {
    "positive": number,
    "neutral": number,
    "negative": number
  },
  "overallSummary": "2-3 sentence summary of feedback across the whole date range",
  "keyHighlights": ["point 1", "point 2", "point 3"],
  "topImprovementSuggestions": ["point 1", "point 2", "point 3"]
}

Submissions:
${input}`;

  const fallback = {
    overallSentimentBreakdown: {
      positive: feedbackRows.filter((f) => f.sentiment === 'Positive').length,
      neutral: feedbackRows.filter((f) => f.sentiment === 'Neutral').length,
      negative: feedbackRows.filter((f) => f.sentiment === 'Negative').length
    },
    overallSummary: `Combined analysis of ${feedbackRows.length} submissions across the selected date range.`,
    keyHighlights: feedbackRows.slice(0, 3).map((f) => `${f.eventName}: ${f.comments}`),
    topImprovementSuggestions: ['Review recurring feedback themes across events.']
  };

  if (!apiKey) return fallback;

  try {
    const genAI = new GoogleGenAI({ apiKey });
    const result = await genAI.models.generateContent({
      model: MODEL,
      contents: prompt,
      config: {
        temperature: 0.4,
        responseMimeType: 'application/json'
      }
    });
    const parsed = parseGeminiJson(result.text);
    if (!parsed) return fallback;
    return {
      overallSentimentBreakdown: {
        positive: Number(parsed.overallSentimentBreakdown?.positive) || fallback.overallSentimentBreakdown.positive,
        neutral: Number(parsed.overallSentimentBreakdown?.neutral) || fallback.overallSentimentBreakdown.neutral,
        negative: Number(parsed.overallSentimentBreakdown?.negative) || fallback.overallSentimentBreakdown.negative
      },
      overallSummary: typeof parsed.overallSummary === 'string' && parsed.overallSummary.trim()
        ? parsed.overallSummary.trim()
        : fallback.overallSummary,
      keyHighlights: Array.isArray(parsed.keyHighlights)
        ? parsed.keyHighlights.filter((h) => typeof h === 'string' && h.trim()).slice(0, 5)
        : fallback.keyHighlights,
      topImprovementSuggestions: Array.isArray(parsed.topImprovementSuggestions)
        ? parsed.topImprovementSuggestions.filter((h) => typeof h === 'string' && h.trim()).slice(0, 5)
        : fallback.topImprovementSuggestions
    };
  } catch (err) {
    console.error('[Gemini] combined analysis failed, using fallback:', err.message);
    return fallback;
  }
}

module.exports = { analyzeFeedback, analyzeCombined, sentimentColor, fallbackAnalysis, parseGeminiJson, MODEL };
