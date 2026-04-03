// src/app/api/log-state/route.ts
import { createClient } from '@supabase/supabase-js';
import { NextResponse } from 'next/server';

// These should be in your environment variables (.env.local)
const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY!;

// Initialize the Supabase client with the service role key
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
  auth: {
    autoRefreshToken: false,
    persistSession: false
  }
});

// Define the shape of the incoming request body. No `any` here.
interface LogStateRequestBody {
  matchId: string;
  state: object; // The SpectatorStateUpdate from Java will be deserialized into a generic object
}

// The POST handler for our API route
export async function POST(request: Request) {
  try {
    const body = (await request.json()) as LogStateRequestBody;
    const { matchId, state } = body;

    if (!matchId || !state) {
      return NextResponse.json({ error: 'Missing matchId or state payload' }, { status: 400 });
    }

    // Your SQL from the previous Java logger, now safely in TypeScript
    const { error } = await supabase.rpc('append_to_match_logs', {
        match_id_to_append: matchId,
        new_state_to_append: state
    });

    if (error) {
      console.error('Supabase RPC error:', error);
      return NextResponse.json({ error: 'Failed to write log to database', details: error.message }, { status: 500 });
    }

    return NextResponse.json({ message: 'Log received and processed successfully' });

  } catch (err: unknown) {
    const error = err as Error;
    console.error('API Error:', error);
    return NextResponse.json({ error: 'Invalid request body', details: error.message }, { status: 400 });
  }
}
