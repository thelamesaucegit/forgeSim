// src/app/api/log-state/route.ts

import { createClient } from '@supabase/supabase-js';
import { NextResponse } from 'next/server';

const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_KEY!);

// The Java logger sends an ARRAY of states, not an object.
type LogStateRequestBody = object[];

export async function POST(request: Request) {
  try {
    // --- THIS IS THE FIX for "Method Not Allowed" ---
    // 1. Get the match ID from the request HEADER, not the body.
    const matchId = request.headers.get('x-match-id');

    // 2. Get the array of states from the body.
    const states = (await request.json()) as LogStateRequestBody;
    
    if (!matchId || !states || !Array.isArray(states) || states.length === 0) {
      return NextResponse.json({ error: 'Missing x-match-id header or state payload array' }, { status: 400 });
    }

    // 3. Call the RPC function for each state in the batch.
    //    Using Promise.all to run them concurrently for better performance.
    const rpcPromises = states.map(state => 
      supabase.rpc('append_to_match_logs', {
        match_id_to_append: matchId,
        new_state_to_append: state
      })
    );

    const results = await Promise.all(rpcPromises);

    // Check if any of the RPC calls failed
    const firstError = results.find(res => res.error);
    if (firstError) {
      console.error('Supabase RPC error while appending log batch:', firstError.error);
      return NextResponse.json({ error: 'Failed to write one or more logs to database', details: firstError.error.message }, { status: 500 });
    }
    // --- END FIX ---

    return NextResponse.json({ message: 'Log batch received and processed successfully' });
  } catch (err: unknown) {
    const error = err as Error;
    console.error('API Error in /api/log-state:', error);
    return NextResponse.json({ error: 'Invalid request body. Ensure it is a valid JSON array.', details: error.message }, { status: 400 });
  }
}
