export interface ReflectionPromptParams {
  explorerName: string;
  companionName?: string;
  companionInReflection?: boolean;
  explorerInReflection?: boolean;
  peopleContext?: string;
}

export function buildReflectionPrompt(params: ReflectionPromptParams): string {
  const {
    explorerName,
    companionName,
    companionInReflection,
    explorerInReflection,
    peopleContext,
  } = params;

  // --- Context lines ---
  const contextLines: string[] = [];

  if (companionName && companionInReflection) {
    contextLines.push(`${companionName} is the sender and has confirmed they appear in the image.`);
  } else if (companionName) {
    contextLines.push(`${companionName} is the sender of this Reflection.`);
  } else {
    contextLines.push('A family member or caregiver is the sender of this Reflection.');
  }

  if (explorerInReflection) {
    contextLines.push(`${explorerName} has been confirmed to be in this image.`);
  } else {
    contextLines.push(`${explorerName} is the AUDIENCE — they are NOT in this image.`);
  }

  const trimmed = peopleContext?.trim();
  if (trimmed) {
    contextLines.push(
      `The sender provided additional context: ${trimmed}. ` +
      'Each comma-separated entry describes a person, pet, or setting.\n' +
      'RULES for these entries:\n' +
      '  - Entries starting with "at" describe a location (e.g. "at Nona\'s house" means this was taken at a place called Nona\'s house). ' +
        'Weave location naturally into the description.\n' +
      '  - Age/species words (baby, toddler, dog, cat, puppy, kitten) before a name are descriptors regardless of capitalization — they are NOT part of the name and must NEVER appear in your output. ' +
        '"baby Dante" or "Baby Dante" means Dante is a baby — call him "Dante". ' +
        '"dog Dalton" or "Dog Dalton" means Dalton is a dog — call him "Dalton". NEVER say "Dog Dalton" or "dog Dalton".\n' +
      '  - Relationship words and nicknames (Grandma, Nona, Uncle, Aunt, Papa) ARE how the person is known. ' +
        '"Grandma Marion" stays "Grandma Marion". "Nona" stays "Nona".\n' +
      '  - Humans are the primary subjects. Pets/animals and locations are mentioned naturally but are secondary.',
    );
  }

  // --- Identity rules ---
  let identityRules: string;

  if (explorerInReflection) {
    identityRules = [
      'IDENTITY RULES:',
      `1. ${explorerName} IS confirmed to be in this image. You may use their name when describing them.`,
      '2. If other people are also visible, use their provided names if given above. Otherwise describe them by visible traits.',
      '3. DO NOT diagnose or guess medical conditions from anyone\'s appearance.',
    ].join('\n');
  } else {
    identityRules = [
      'CRITICAL IDENTITY RULES:',
      `1. NEVER identify any person in the image as ${explorerName}. They are the viewer, not a subject.`,
      '2. If the sender identified people by name above, use those names. Otherwise describe people by visible traits (e.g. "a baby", "a woman").',
      '3. DO NOT diagnose or guess medical conditions from anyone\'s appearance.',
    ].join('\n');
  }

  // --- Companion rules ---
  let companionRules: string;

  if (companionName && companionInReflection) {
    companionRules =
      `Since ${companionName} is both the sender and visible, you may refer to them by name. ` +
      `Write as if ${companionName} is sharing a moment they are part of.`;
  } else if (companionName) {
    companionRules =
      `Briefly work ${companionName}'s name into the wording so it feels like the Reflection comes from them. ` +
      `Do not say ${companionName} is in the image unless confirmed above.`;
  } else {
    companionRules = 'You may briefly refer to the sender as a family member or caregiver.';
  }

  // --- Assemble ---
  const contextBlock = contextLines.map((l) => `- ${l}`).join('\n');

  return (
    `Analyze this image for a 15-year-old with Angelman Syndrome named ${explorerName}.\n` +
    '\n' +
    'CONTEXT:\n' +
    `${contextBlock}\n` +
    '\n' +
    `${identityRules}\n` +
    '\n' +
    'CONTENT RULES:\n' +
    `4. The short_caption is a warm, high-energy greeting TO ${explorerName} about what is in the image (max 10 words).\n` +
    `5. The deep_dive is a 2-3 sentence story about interesting details, written as if speaking TO ${explorerName}.\n` +
    `6. ${companionRules}\n` +
    '\n' +
    'Return a SINGLE JSON object:\n' +
    '{"short_caption": "string", "deep_dive": "string"}'
  );
}
