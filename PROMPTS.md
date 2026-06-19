# Prompt templates (general) — auto-boxer

Cara kerja 4 field yang ngendaliin boxing:

| Field | Buat apa |
|---|---|
| **`context`** | Deskripsi LAYOUT scene-nya, **sekali** — di-prepend ke box1 & box2. Cukup soal layout, jangan masukin daftar jenis konten di sini. |
| **`bbox_1`** | Subjek **box1** (atas) = orang utama / yang ngomong. Detail boleh panjang. |
| **`bbox_2`** | Subjek **box2** (bawah) = orang kedua ATAU konten. Di sinilah jenis-jenis konten di-list. |
| **`expect`** | **Output 9:16 yang diinginkan** — dibaca SUTRADARA buat mutusin split/full + sisi + blur/cover. Ini yang baru. |

Plus toggle (file-level `_director` / `_diarization` / `_expect`, atau per-clip):
- **`director: true`** — sutradara nyalain (window + transkrip + speaker → segmen). **Wajib nyala** biar `expect` kepake.
- **`diarization: true`** — sutradara tau **siapa yang ngomong** (penting buat podcast 2-3 orang).

Prinsip yang udah kebukti:
- box1 = orang (cover), box2 = konten/orang-kedua (blur_pad — aspect konten kejaga).
- "Wajah yang muncul DI DALAM video/meme/post = bagian dari konten" → box2 ngotakin **seluruh area konten**, bukan orang di dalemnya.
- "Tembok/rak/studio polos BUKAN konten" → jangan bikin split palsu.
- Full ATAU split dua-duanya sah (full = satu subjek ngisi layar).

---

## 1) Reaction (streamer nge-react ke meme/video/post)

```json
{
  "context": "A reaction video: a live streamer's webcam and the content they react to (a meme, video clip, screenshot, social post, or news footage) share the screen.",
  "bbox_1": "The live streamer / on-camera reactor — their face and upper body in the webcam, with headroom (never crop the head, forehead, or chin). NOT the content. A person shown INSIDE the reacted video/meme is content, not the streamer.",
  "bbox_2": "The content being reacted to — the meme / video clip / screenshot / tweet or social post / news footage that fills its region. Box the WHOLE content area. A face inside that content is PART of the content (box the content, not the face). A plain wall/desk/studio background is NOT content.",
  "expect": "A 9:16 reaction reel. When the streamer's webcam AND the content are both on screen, SPLIT: the streamer (face + upper body, head not cropped) on top, the content FULL on the bottom. When only the streamer fills the screen, show the streamer full. When the content fills the screen, show the content full. Never crop a head."
}
```

## 2) Dakwah (ceramah / ustadz — sering 1 orang, kadang ada teks/slide)

```json
{
  "context": "An Islamic lecture / dakwah: a speaker (ustadz/ustadzah) addressing the audience; sometimes an on-screen verse, hadith, title card, or slide is shown.",
  "bbox_1": "The speaker (ustadz/ustadzah) currently talking — face and upper body, centered, WITH headroom (never crop the head, forehead, or chin). Calm, respectful framing.",
  "bbox_2": "On-screen text/graphic shown as its own region — a Qur'an verse, hadith, title card, or supporting slide. Box the whole text/graphic area. NOT the speaker. (Often absent — most of the clip is just the speaker.)",
  "expect": "A 9:16 dakwah reel. Keep the speaker centered with their WHOLE head and headroom (never crop the head). When a verse / slide / graphic fills the frame, show it FULL. When the speaker fills the screen, show the speaker full. Respectful, clean framing — no awkward crops."
}
```

## 3) Podcast / talk-show (2-3 host/tamu)

```json
{
  "context": "A talk-show / podcast: two or three hosts/guests on camera talking; occasionally a graphic, photo, flyer, or score fills the screen.",
  "bbox_1": "The person currently SPEAKING — face and upper body, head not cropped, with headroom. Follow whoever is talking.",
  "bbox_2": "Another host/guest on camera (the one NOT currently speaking) in their own area; OR a graphic / photo / flyer / score when one fills the screen. NOT the same person already in box1.",
  "expect": "A 9:16 podcast reel. Show whoever is SPEAKING with their whole head + headroom. When two people are clearly on camera, SPLIT: the speaker on top, the other person on the bottom. When a graphic / score / photo fills the frame, show it FULL. Never crop a head."
}
```

> Podcast paling butuh **`diarization: true`** — itu yang ngasih tau sutradara siapa yang lagi ngomong (vision model nggak bisa denger). Tanpa diarization, dia nebak dari visual.

---

## Contoh JSON import lengkap (reaction, semua toggle nyala)

```json
{
  "_director": true,
  "_diarization": true,
  "_context": "A reaction video: a live streamer's webcam and the content they react to share the screen.",
  "_expect": "A 9:16 reaction reel. Both on screen → SPLIT (streamer top, content full bottom). One fills the screen → that one full. Never crop a head.",
  "https://www.youtube.com/watch?v=XXXX": [
    {
      "id": "rx01", "start": "00:01:23", "end": "00:01:58",
      "title": "Reaksi streamer kaget",
      "description": "...",
      "bbox_1": "The live streamer reacting — face + upper body in the webcam, head not cropped. Not the content.",
      "bbox_2": "The meme/video being reacted to — box the whole content area. A face inside it is part of the content."
    }
  ]
}
```

`_context` / `_expect` (level file) berlaku ke semua clip; bisa di-override per-clip dengan `context` / `expect`. Catatan: prompt sengaja ENGLISH (vision model + sutradara baca English lebih stabil); caption/judul tetap ikut bahasa konten (Indonesia).
