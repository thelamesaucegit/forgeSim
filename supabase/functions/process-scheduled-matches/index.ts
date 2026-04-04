import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const APP_URL = Deno.env.get('APP_URL')!; // e.g. https://yourapp.vercel.app

interface ScheduledMatch {
    id: string;
    team1_id: string;
    team2_id: string;
    season_number: number;
    week_number: number;
    match_date: string;
    team1_ai_profile: string | null;
    team2_ai_profile: string | null;
    deck1_override: string | null;
    deck2_override: string | null;
}

interface DeckSubmission {
    deck_list: string;
    submitted_at: string;
}

interface TeamDeck {
    id: string;
    updated_at: string;
}

interface DeckCard {
    card_name: string;
    quantity: number | null;
}

interface MatchRunnerResponse {
    matchId: string;
}

interface SeasonRow {
    id: string;
}

interface ScheduleWeekRow {
    id: string;
}

function formatAsDck(teamId: string, cards: DeckCard[]): string {
    const lines = cards.map(c => `${c.quantity ?? 1} ${c.card_name}`).join('\n');
    return `[metadata]\nName=${teamId}\n\n[Main]\n${lines}`;
}

async function resolveWeekId(
    supabase: ReturnType<typeof createClient>,
    seasonNumber: number,
    weekNumber: number
): Promise<string | null> {
    const { data: season } = await supabase
        .from('seasons')
        .select('id')
        .eq('season_number', seasonNumber)
        .returns<SeasonRow[]>()
        .maybeSingle();

    if (!season) return null;

    const { data: week } = await supabase
        .from('schedule_weeks')
        .select('id')
        .eq('season_id', season.id)
        .eq('week_number', weekNumber)
        .returns<ScheduleWeekRow[]>()
        .maybeSingle();

    return week?.id ?? null;
}

async function getDecklistForTeam(
    supabase: ReturnType<typeof createClient>,
    teamId: string,
    weekId: string | null
): Promise<string | null> {
    // Tier 1: week-specific submission
    if (weekId) {
        const { data } = await supabase
            .from('deck_submissions')
            .select('deck_list, submitted_at')
            .eq('team_id', teamId)
            .eq('week_id', weekId)
            .eq('is_current', true)
            .order('submitted_at', { ascending: false })
            .returns<DeckSubmission[]>()
            .limit(1)
            .maybeSingle();

        if (data?.deck_list) return data.deck_list;
    }

    // Tier 2: most recent submission any week
    const { data: latest } = await supabase
        .from('deck_submissions')
        .select('deck_list, submitted_at')
        .eq('team_id', teamId)
        .eq('is_current', true)
        .order('submitted_at', { ascending: false })
        .returns<DeckSubmission[]>()
        .limit(1)
        .maybeSingle();

    if (latest?.deck_list) return latest.deck_list;

    // Tier 3: build from deck_cards directly
    const { data: deck } = await supabase
        .from('team_decks')
        .select('id, updated_at')
        .eq('team_id', teamId)
        .order('updated_at', { ascending: false })
        .returns<TeamDeck[]>()
        .limit(1)
        .maybeSingle();

    if (!deck) return null;

    const { data: cards } = await supabase
        .from('deck_cards')
        .select('card_name, quantity')
        .eq('deck_id', deck.id)
        .eq('category', 'mainboard')
        .returns<DeckCard[]>();

    if (!cards || cards.length === 0) return null;

    return formatAsDck(teamId, cards);
}

Deno.serve(async (_req: Request): Promise<Response> => {
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    // Find matches due within the next 60 minutes
    const now = new Date();
    const windowEnd = new Date(now.getTime() + 60 * 60 * 1000).toISOString();

    const { data: matches, error: fetchError } = await supabase
        .from('schedule')
        .select(`
            id,
            team1_id,
            team2_id,
            season_number,
            week_number,
            match_date,
            team1_ai_profile,
            team2_ai_profile,
            deck1_override,
            deck2_override
        `)
        .eq('status', 'scheduled')
        .lte('match_date', windowEnd)
        .returns<ScheduledMatch[]>();

    if (fetchError) {
        console.error('[CRON] Failed to fetch scheduled matches:', fetchError.message);
        return new Response(
            JSON.stringify({ error: fetchError.message }),
            { status: 500, headers: { 'Content-Type': 'application/json' } }
        );
    }

    if (!matches || matches.length === 0) {
        console.log('[CRON] No matches due within the next 60 minutes.');
        return new Response(
            JSON.stringify({ processed: 0 }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
    }

    console.log(`[CRON] Found ${matches.length} match(es) to process.`);

    const results: Array<{ scheduleId: string; success: boolean; simMatchId?: string; error?: string }> = [];

    for (const match of matches) {
        try {
            // Mark as in_progress immediately to prevent double-processing
            const { error: updateError } = await supabase
                .from('schedule')
                .update({ status: 'in_progress' })
                .eq('id', match.id)
                .eq('status', 'scheduled'); // guard against race condition

            if (updateError) {
                console.error(`[CRON] Failed to mark ${match.id} as in_progress:`, updateError.message);
                results.push({ scheduleId: match.id, success: false, error: updateError.message });
                continue;
            }

            // Resolve week_id for deck lookup
            const weekId = await resolveWeekId(supabase, match.season_number, match.week_number);

            // Fetch decklists
            const deck1 = match.deck1_override ?? await getDecklistForTeam(supabase, match.team1_id, weekId);
            const deck2 = match.deck2_override ?? await getDecklistForTeam(supabase, match.team2_id, weekId);

            if (!deck1 || !deck2) {
                const msg = `Missing decklist — team1: ${deck1 ? 'ok' : 'missing'}, team2: ${deck2 ? 'ok' : 'missing'}`;
                console.error(`[CRON] ${match.id}: ${msg}`);
                await supabase
                    .from('schedule')
                    .update({ status: 'sim_failed' })
                    .eq('id', match.id);
                results.push({ scheduleId: match.id, success: false, error: msg });
                continue;
            }

            // Trigger the simulation via the Next.js API route
            const simResponse = await fetch(`${APP_URL}/api/match-runner`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    deck1: {
                        content: deck1,
                        aiProfile: match.team1_ai_profile ?? 'Default',
                    },
                    deck2: {
                        content: deck2,
                        aiProfile: match.team2_ai_profile ?? 'Default',
                    },
                    team1Id: match.team1_id,
                    team2Id: match.team2_id,
                }),
            });

            if (!simResponse.ok) {
                const errorBody = await simResponse.json() as { error?: string };
                const msg = errorBody.error ?? `HTTP ${simResponse.status}`;
                console.error(`[CRON] Sim trigger failed for ${match.id}:`, msg);
                await supabase
                    .from('schedule')
                    .update({ status: 'sim_failed' })
                    .eq('id', match.id);
                results.push({ scheduleId: match.id, success: false, error: msg });
                continue;
            }

            const { matchId: simMatchId } = await simResponse.json() as MatchRunnerResponse;

            // Write sim_match_id back — status stays 'in_progress' until server.ts completes
            await supabase
                .from('schedule')
                .update({ sim_match_id: simMatchId })
                .eq('id', match.id);

            console.log(`[CRON] Match ${match.id} → sim started, sim_match_id: ${simMatchId}`);
            results.push({ scheduleId: match.id, success: true, simMatchId });

        } catch (e) {
            const msg = e instanceof Error ? e.message : 'Unexpected error';
            console.error(`[CRON] Unhandled error for match ${match.id}:`, msg);
            await supabase
                .from('schedule')
                .update({ status: 'sim_failed' })
                .eq('id', match.id);
            results.push({ scheduleId: match.id, success: false, error: msg });
        }
    }

    return new Response(
        JSON.stringify({ processed: matches.length, results }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
});
