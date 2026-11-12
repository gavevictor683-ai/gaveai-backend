function normalizeStoryboardScenes(scenes) {
  if (!Array.isArray(scenes)) return [];
  return scenes.map((scene, index) => {
    const current = scene || {};
    const duration = Number(current.duration) === 8 ? 8 : 5;
    const voiceText = String(current.voiceText || current.voice?.text || current.dialogue || current.narration || current.voicePrompt || "").trim();
    const voiceLanguage = String(current.voiceLanguage || current.voice_language || current.language || current.voice?.language || "").trim();
    const voiceId = String(current.voiceId || current.voice_id || current.voiceName || current.voice?.name || (typeof current.voice === "string" ? current.voice : "") || "").trim();
    const voiceEmotion = String(current.voiceEmotion || current.emotion || current.voice?.emotion || "").trim();
    const voiceSpeed = current.voiceSpeed ?? current.speed ?? current.voice?.speed ?? null;
    const voicePitch = current.voicePitch ?? current.pitch ?? current.voice?.pitch ?? null;
    const languageBoost = String(current.languageBoost || current.language_boost || "").trim();
    const musicPrompt = String(current.musicPrompt || current.music || "").trim();
    const musicVolume = current.musicVolume ?? 0.7;
    const sfxPrompt = String(current.sfxPrompt || current.sfx || "").trim();
    const sfxVolume = current.sfxVolume ?? 0.7;
    const ambiencePrompt = String(current.ambiencePrompt || current.ambience || "").trim();
    const ambienceVolume = current.ambienceVolume ?? 0.5;
    return {
      id: current.id || `scene-${index + 1}`,
      index,
      prompt: String(current.prompt || "").trim(),
      duration,
      voice: String(current.voice || "").trim(),
      voiceText,
      voiceLanguage,
      voiceId,
      voiceEmotion,
      voiceSpeed,
      voicePitch,
      languageBoost,
      dialogue: String(current.dialogue || "").trim(),
      narration: String(current.narration || "").trim(),
      mainCharacter: current.mainCharacter || "",
      supportingCharacters: current.supportingCharacters || "",
      age: current.age || "",
      gender: current.gender || "",
      appearance: current.appearance || "",
      clothing: current.clothing || "",
      personality: current.personality || "",
      voiceStyle: current.voiceStyle || current.voice_style || "",
      speakingStyle: current.speakingStyle || current.speaking_style || "",
      visualStyle: current.visualStyle || "",
      cameraStyle: current.cameraStyle || "",
      environment: current.environment || "",
      audioDirection: current.audioDirection || current.audio_direction || "",
      music: String(current.music || "").trim(),
      musicPrompt,
      musicVolume,
      sfx: String(current.sfx || "").trim(),
      sfxPrompt,
      sfxVolume,
      ambience: String(current.ambience || "").trim(),
      ambiencePrompt,
      ambienceVolume,
      imageUrl: current.imageUrl || current.image || null,
      videoUrl: current.videoUrl || current.video || null,
      firstFrameImage: current.firstFrameImage || null,
      lastFrameImage: current.lastFrameImage || null,
      continuityContext: String(current.continuityContext || "").trim()
    };
  }).filter((scene) =>
    scene.prompt || scene.imageUrl || scene.videoUrl || scene.dialogue || scene.narration ||
    scene.voiceText || scene.musicPrompt || scene.sfxPrompt || scene.ambiencePrompt
  );
}

function applyCharacterBibleToScenes(scenes, bible = {}) {
  const fields = [
    "mainCharacter", "supportingCharacters", "age", "gender", "appearance", "clothing",
    "personality", "voiceStyle", "speakingStyle", "visualStyle", "cameraStyle",
    "environment", "audioDirection"
  ];
  return scenes.map((scene) => {
    const normalized = { ...scene };
    for (const field of fields) normalized[field] = bible[field] || normalized[field] || "";
    return normalized;
  });
}

function buildStoryboardContinuity(scenes, buildCharacterBible) {
  return normalizeStoryboardScenes(scenes).map((scene, index) => [
    `Scene ${index + 1}`,
    scene.prompt ? `Visual: ${scene.prompt}` : "",
    scene.voice ? `Voice: ${scene.voice}` : "",
    scene.dialogue ? `Dialogue: ${scene.dialogue}` : "",
    scene.narration ? `Narration: ${scene.narration}` : "",
    buildCharacterBible(scene),
    scene.music ? `Music: ${scene.music}` : "",
    scene.sfx ? `SFX: ${scene.sfx}` : "",
    scene.ambience ? `Ambience: ${scene.ambience}` : ""
  ].filter(Boolean).join("\n")).join("\n").trim();
}

module.exports = {
  normalizeStoryboardScenes,
  applyCharacterBibleToScenes,
  buildStoryboardContinuity
};
