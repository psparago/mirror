# Reflection Composer — Design Intent

## What This Is

The Reflection Composer is the most important screen in Reflections Connect. It is where a Companion turns a photo or video into something the Explorer can *understand*. Not just see — understand. Feel. Connect with.

This is not a media uploader. It is a creative tool for people who care deeply about someone with cognitive disabilities. Every decision in this editor exists to help the Companion express what is happening in a Reflection so that the Explorer experiences it as a personal, meaningful moment — not noise.

## Where We Came From

The original composer was a quick prototype. Pick media, let AI generate a caption, send. It worked, but it treated the Companion as a button-presser and the Reflection as a commodity. There was no room for nuance, no way to say "AI, you got this wrong — that's not a stranger, that's Nona." No way to iterate. No craft.

That version was a frankenstein toy. What we are building now is something else entirely.

## What We Are Building

A Companion's workbench. A place where someone who loves the Explorer can shape every dimension of a Reflection until it is *right*:

- **Trim** the video to the exact moment that matters. Not the whole clip — the three seconds where the dog jumps into the pool.
- **Frame** the poster image so the Explorer sees the right face, the right moment, the right context before the video even plays.
- **Speak** the context — tap once and tell Sparkle who is in the photo, where you are, what is happening. Uhhs and umms are fine. The AI cleans the transcript and uses it so captions and Rich Narration are accurate, not generic guesses.
- **Sparkle** — review what the AI wrote, adjust, run it again. Iterate until the caption and deep dive actually describe what is happening in a way the Explorer will understand.
- **Choose delivery** — after speaking, pick **My voice** (default: Explorer hears the raw recording) or **Clean caption** (polished text spoken by AI TTS).
- **Write** a caption by hand if needed. Or tweak what speech + Sparkle suggested. The Companion always has the final word.
- **Bring It to Life** — for photos, record a selfie narration in the PiP corner the Explorer will see. That narration *is* the spoken intro, and it also feeds the same spoken-context pipeline for accurate AI.
- **Apply a Look** — a filter that changes the mood of a photo. Not a gimmick. A creative choice.

These layers work together. Speaking is the fast path to accuracy. Craft tools remain for when the Companion wants them. This is not a linear wizard. It is an editor with a voice-first 80/20.

## The Sparkle Philosophy (Sparkle Speak)

AI is a collaborator, not an autopilot. The primary act on Sparkle is **Tell the story**:

1. Companion taps the mic and speaks freely.
2. Gemini cleans the transcript into people/place context and a short suggested caption.
3. Sparkle generates Rich Narration (and caption text) informed by that spoken context — trusting what the Companion said over visual guessing when they conflict.
4. Companion chooses what the Explorer hears: **My voice** or **Clean caption**.
5. If something is wrong, they speak again, edit the caption, tweak typed context (collapsed under “Or type context”), or Run Sparkle again.

Typed “Context for AI” remains available as a fallback for silent environments. Presence toggles (“I’m in this” / “Explorer is in this”) stay visible — cheap and high-signal.

Bring-It-to-Life PiP is sacred: we do not redesign the face-in-the-corner experience. We only teach Sparkle from the same narration audio/video.

The only time AI runs automatically without an explicit Run Sparkle tap is after a successful Speak (or BITL narration) — so the Companion hears Rich Narration quickly. For edits where a caption already exists, modes like keepCaption still respect the Companion’s words.

If the Companion changes something meaningful (trim, thumbnail, caption, filter) after the last Sparkle run and tries to send or preview, the editor gently asks or auto-refreshes as needed. The Companion can always send anyway when the gate is satisfied.

## The 80/20 Fast Path

Most new Reflections will be quick: pick media → glance Workbench → Sparkle → **tap mic and talk** → land on cleaned context + caption with **My voice** selected → hear Rich Narration → Finish → Send.

That is the storm path. Typing structured hints is optional. Speaking is the default.

When a Companion wants to craft something special — a birthday video, a family reunion photo, a moment with a new pet — every tool is there. No hidden menus that hide the mic. The same editor, the same flow. Just used with more intention.

## The North Star

A Companion sits down with a video of the Explorer's grandmother visiting. They trim to the moment Nona walks through the door. They set the poster frame to her smiling face. They tap Tell the story: "Hey buddy, look — that's Nona, uh, she just got here, Dalton's going crazy." Sparkle cleans it, drafts a warm caption, and a Rich Narration that actually knows Nona. They keep **My voice**. They preview — poster, video, back to Nona's smile, then their familiar voice — and it is *perfect*. They send.

Or for a photo: they Bring It to Life with a selfie in the corner, Sparkle learns from that narration too, and the Explorer sees the face they love while hearing the story.

The Explorer sees Nona's face in the timeline. The video plays. They hear a familiar voice say their name. They double-tap to like it back. They understand. They smile. They tap the selfie button and send a reaction back.

That is what this editor is for.
