// notebook-seed.js — the first fill of the `support_notebook` n8n Data Table.
//
// Source: the client's "Ai Q&A" review (customer question → what our support
// staff actually answer). These are EXAMPLES + LESSONS, not keyword rules:
// at chat time the bot finds the entries closest in MEANING to the customer's
// message (embeddings) and follows the staff pattern, so a differently-worded
// question still gets the staff-style answer.
//
// After the first seed, the table is owned by staff (edited from
// perfecto-ai-ops). dev/setup-notebook.mjs only inserts entry_keys that don't
// exist yet — it never overwrites a row someone has edited.
//
// Fields:
//   key            stable id (entry_key column)
//   topic          free label for grouping in the admin screen
//   q              a real customer question
//   alt            other ways customers ask the same thing (helps matching)
//   a              the staff answer
//   lesson         WHY staff answer this way — the part the AI generalises from
//   exact          true = reuse the staff text as-is (numbers, links, policy)
//   golden         true = lesson is shown to the AI on EVERY message
//   free           true = still answered after the daily message limit

export const NOTEBOOK_SEED = [
  // ---- safety: no product suggestions, send to a doctor --------------------
  {
    key: 'allergy-skin', topic: 'safety', golden: true,
    q: 'allergy skin e moisturiser konta use korbo?',
    alt: 'amar skin e allergy ache kon cream dibo | এলার্জি আছে কোন ক্রিম ব্যবহার করবো | skin e chulkani rash hoy ki use korbo | sensitive reaction hoy product suggest koren',
    a: 'এলার্জি জনিত সমস্যা থাকলে আমরা কোন ধরনের স্কিন কেয়ার প্রোডাক্ট সাজেস্ট করে থাকি না ম্যাম।\n\nযেহেতু আপনার এলার্জি জনিত সমস্যা আছে, কাইন্ডলি ডার্মাটোলজিস্টের কনসালটেশনে যে কোন স্কিন কেয়ার প্রোডাক্ট ইউজ করুন ম্যাম।\n\nধন্যবাদ।',
    lesson: 'If the customer has allergy, rash, itching or reacts to products: never suggest any product (no product cards). Politely refer them to a dermatologist.',
  },
  {
    key: 'pregnancy-breastfeeding', topic: 'safety', golden: true,
    q: 'ami pregnant time cholche ekhon amar skin type oily ekhon dot & key watermelon sunscreen ti use korte parbo?',
    alt: 'pregnancy te ki use kora jabe | বাচ্চাকে দুধ খাওয়াচ্ছি কোন প্রোডাক্ট ব্যবহার করবো | breastfeeding e serum use korte parbo | গর্ভাবস্থায় স্কিনকেয়ার',
    a: 'দুঃখিত ম্যাম, গর্ভাবস্থায় এবং শিশুকে বুকের দুধ খাওয়ানোর সময় আমরা আপনাকে যেকোনো ধরনের কসমেটিকস ও স্কিনকেয়ার পণ্য ব্যবহার না করার পরামর্শ দিয়ে থাকি।\n\nধন্যবাদ ম্যাম।',
    lesson: 'Pregnant or breastfeeding customers: advise not to use any cosmetics or skincare product, even if they name a specific product. No product suggestions.',
  },
  {
    key: 'cystic-acne', topic: 'safety', golden: true,
    q: 'Cystic acne skin e facewash ba moisturiser konta use korbo?',
    alt: 'boro boro betha jukto bron e ki use korbo | puj wala bron er jonno ki lagabo | hormonal acne er jonno product din | fungal acne lal hoye thaka skin e ki use korbo | ব্যথাযুক্ত বড় ব্রণ | পুঁজ যুক্ত ব্রণ | painful acne with pus, what should I use',
    a: 'আপনার স্কিন কন্ডিশন অনুযায়ী আপনি একজন বিশেষজ্ঞ ডার্মাটোলজিস্টের পরামর্শ নিন কাইন্ডলি ম্যাম।\n\nআপনি চাইলে আপনার নিকটস্থ একজন ডার্মাটোলজিস্টের পরামর্শ নিতে পারেন কিংবা পারফেক্টোতে মাত্র ৪০০ টাকায় অনলাইনে ডার্মাটোলজিস্ট দেখাতে পারেন ম্যাম।\n\nডার্মাটোলজিস্ট দেখানোর জন্য নিচের ফর্মটি পূরন করুন ম্যাম।\n\nhttps://tinyurl.com/2wk9pxj8',
    lesson: 'Cystic, hormonal, fungal, painful ("betha") or pus-filled ("puj") acne, or big painful pimples, is a medical condition: suggest no product; refer to a dermatologist and offer Perfecto\'s 400 TK online dermatologist consultation form. This wins over the ordinary acne rules.',
    exact: true,
  },
  {
    key: 'thin-skin-veins', topic: 'safety', golden: true,
    q: 'amar skin onek beshi patla rog dekha jay kon serum ti use korte parbo?',
    alt: 'skin patla shira dekha jay | পাতলা স্কিন রগ দেখা যায় কি ব্যবহার করবো | very thin skin veins visible',
    a: 'পাতলা স্কিনে আমরা কোনো স্কিন কেয়ার প্রোডাক্ট সাজেস্ট করে থাকি না।\nকাইন্ডলি ডাক্তার কনসালটেশনে যেকোনো স্কিন কেয়ার প্রোডাক্ট ইউজ করুন ম্যাম।',
    lesson: 'Very thin skin with visible veins: suggest no product, refer to a doctor.',
  },

  // ---- ask before suggesting -------------------------------------------------
  {
    key: 'ask-before-suggesting', topic: 'ask first', golden: true,
    q: 'normal skin er jonno sunscreen konta use korbo?',
    alt: 'amar jonno kon serum valo hobe | kon moisturiser nibo | ki product use korbo suggest koren',
    a: 'আপনার স্কিন টাইপ?\nআপনার বয়স?\nআপনার স্কিনে একনে বা এলার্জি প্রবলেম আছে ম্যাম কাইন্ডলি জানাবেন।',
    lesson: 'Before recommending any skincare product, first ask skin type, age, and whether they have acne or allergy — unless they already told us. Do not list products in the same reply.',
  },

  // ---- age rules -------------------------------------------------------------
  {
    key: 'age-18-plus', topic: 'age', golden: true,
    q: 'apnar koto age theke product suggest koren?',
    alt: 'amar boyosh 16 ki use korbo | কত বছর বয়স থেকে প্রোডাক্ট ব্যবহার করা যায়',
    a: 'Our all products are for 18+ age mam.',
    lesson: 'All Perfecto products are for age 18+. Under 18: do not suggest products.',
  },
  {
    key: 'serum-age-17', topic: 'age',
    q: 'Acne skin e kon serum ti use korbo amar age 17',
    alt: 'ami 17 bochor serum use korte parbo | কম বয়সে সিরাম',
    a: 'আমাদের সকল প্রোডাক্ট ১৮+ বয়সের জন্য ম্যাম।\nতবে সিরাম ২০+ বয়স থেকে ইউজ করা ভালো।',
    lesson: 'Serums are best from age 20+. All products are 18+.',
  },
  {
    key: 'snail-age-25', topic: 'age',
    q: 'amar age 20, Snail cream konta valo hobe?',
    alt: 'snail mucin kon boyosh theke | স্নেইল ক্রিম কত বয়সে',
    a: 'Snail আমরা ২৫+ বয়স থেকে সাজেস্ট করে থাকি ম্যাম।',
    lesson: 'Snail products are suggested only from age 25+.',
  },
  {
    key: 'retinal-beginner', topic: 'age',
    q: 'retinal ki beginner friendly?',
    alt: 'prothom bar retinal use korte parbo | রেটিনাল কি নতুনদের জন্য',
    a: 'No mam, retinal beginner friendly na. Retinal 25+ age theke suggest kora hoye thake. Retinal use korar age retinol use korte hobe mam.',
    lesson: 'Retinal is not for beginners: only age 25+, and only after the skin is used to retinol.',
  },

  // ---- acne: what not to use --------------------------------------------------
  {
    key: 'acne-no-brightening', topic: 'acne', golden: true,
    q: 'acne ache glowing ba brightening er jonno ki use korbo?',
    alt: 'bron ache kintu skin ujjol korte chai | একনে আছে গ্লোয়িং প্রোডাক্ট',
    a: 'একনে স্কিনে গ্লোয়িং বা ব্রাইটেনিং প্রোডাক্ট সুইটেবেল না ম্যাম।',
    lesson: 'Acne skin: glowing/brightening products, niacinamide serums and sheet masks are not suitable. Say so instead of suggesting them.',
  },
  {
    key: 'acne-no-niacinamide', topic: 'acne',
    q: 'acne skin e Niacinamide serum konta use korbo?',
    alt: 'bron e niacinamide valo | ব্রণে নিয়াসিনামাইড',
    a: 'Acne skin e niacinamide serum suitable na mam.',
    lesson: 'Niacinamide serum is not suitable for acne skin.',
  },
  {
    key: 'acne-no-sheet-mask', topic: 'acne',
    q: 'acne skin e sheet mask konta use korbo?',
    alt: 'bron ache sheet mask dite parbo | ব্রণে শিট মাস্ক',
    a: 'Acne skin e sheet mask suitable na mam.',
    lesson: 'Sheet masks are not suitable for acne skin.',
  },

  // ---- things we don't sell --------------------------------------------------
  {
    key: 'not-available', topic: 'not available', golden: true,
    q: 'Whitening er jonno ki use korbo?',
    alt: 'glass skin er jonno ki use korbo | milia r freckles er product ache | gorter kono product ache | ফর্সা হওয়ার ক্রিম',
    a: 'whitening product amader kache available nei mam.',
    lesson: 'We do not sell whitening, glass-skin, milia/freckles or pore-filling ("gorter") products. Say it is not available; do not offer other products as a replacement.',
  },
  { key: 'glass-skin', topic: 'not available', q: 'glass skin er jonno ki use korbo?', alt: 'glass skin pete chai', a: 'Glass skin er jonno kono product amader available nei mam.', lesson: 'No glass-skin products.' },
  { key: 'milia-freckles', topic: 'not available', q: 'milia r freckles er product er kono product ache?', alt: 'মিলিয়া ফ্রেকলস', a: 'মিলিয়া এবং ফ্রেকলেস এর কোনো প্রোডাক্ট নেই ম্যাম।', lesson: 'No milia or freckles products.' },
  { key: 'pores', topic: 'not available', q: 'gorter kono product ache?', alt: 'mukher gorto | open pores bhorar product | গর্তের দাগ', a: 'গর্তের কোনো প্রোডাক্ট নেই ম্যাম।', lesson: 'No products for pitted scars / pores ("gorto").' },
  { key: 'sweating', topic: 'not available', q: 'sweating control korar jonno ki use korbo?', alt: 'ghum kom korar product | ঘাম বন্ধ', a: 'Sweating ekti natural process mam, eta control kora jay na.', lesson: 'Sweating is natural; we do not suggest products to control it.' },

  // ---- how-to tips -----------------------------------------------------------
  {
    key: 'retinal-how-to', topic: 'how to',
    q: 'retinal kivabe use korbo?',
    alt: 'retinol use korar niyom | রেটিনল কিভাবে লাগাবো',
    a: 'প্রথমে মুখ ধোয়ার পর হালকা এক স্তর ময়েশ্চারাইজার লাগান।\nময়েশ্চারাইজার শুকিয়ে গেলে তার ওপর মটরদানা পরিমাণ রেটিনল লাগান।\nসবশেষে আবার এক স্তর ভালো ময়েশ্চারাইজার দিয়ে ত্বক লক করে দিন।\n(এতে কার্যকারিতা সামান্য ধীর হলেও ত্বকে র‍্যাশ, লালচে ভাব বা জ্বালাপোড়ার ঝুঁকি থাকে না।)\nদিনের বেলা সানস্ক্রিন অবশ্যই ইউজ করতে হবে। রেটিনাল অনেক বেশি পাওয়ারফুল হওয়ায় একই সময় অন্য একটিভ ইনগ্রেডিয়েন্টের প্রোডাক্ট ব্যবহার করা যাবে না।',
    lesson: 'Retinol/retinal: moisturiser sandwich (moisturiser → pea-size retinol → moisturiser), sunscreen in the day, no other actives at the same time. Give the steps; don\'t send them to the hotline.',
  },
  {
    key: 'serum-timing', topic: 'how to',
    q: 'serum kon time e use kora better?',
    alt: 'সিরাম দিনে না রাতে',
    a: 'সিরাম নাইট টাইমে ইউজ করা ভালো, তবে দিনের বেলা ইউজ করলে অবশ্যই সানস্ক্রিন ইউজ করতে হবে ম্যাম।',
    lesson: 'Serum is best at night; if used in the day, sunscreen is a must. Keep it short.',
  },
  {
    key: 'dried-mascara', topic: 'how to',
    q: 'mascara & eyeliner shukhiye gele kivabe use korbo?',
    alt: 'কাজল শুকিয়ে গেছে | eyeliner dry hoye geche',
    a: 'মাস্কারা বা আইলাইনার শুকিয়ে গেলে দুরালিন ইউজ করতে পারবেন। শুকিয়ে যাওয়া মাস্কারা বা আইলাইনারে ১ ফোঁটা দুরালিন দিয়ে পরিষ্কার spatula দিয়ে ভালোভাবে মিশিয়ে নিন। প্রয়োজন হলে অল্প পরিমাণে আরও দুরালিন যোগ করুন, এতে টেক্সচার স্মুথ হতে পারে।',
    lesson: 'Dried mascara/eyeliner: add a drop of Duraline and mix with a clean spatula.',
  },
  {
    key: 'lips-darkening', topic: 'how to',
    q: 'lipstick use korle lips kalo hoye jay keno?',
    alt: 'ঠোঁট কালো হয়ে যাচ্ছে',
    a: 'Jekono lip products use korle proper lip care maintain korle usually problem hoy na.\nRegular lip balm use, gently exfoliate korle lip dark or pigmented hobe na.',
    lesson: 'Lip darkening: explain proper lip care (lip balm, gentle exfoliation). Don\'t blame the product, don\'t send to hotline.',
  },
  {
    key: 'lipstick-not-setting', topic: 'how to',
    q: 'imagic waterproof lipstick use korar por lips e boshche na, kichukhon por guragura hoye uthe jay, product ki authentic?',
    alt: 'lipstick flaky hoye jay | লিপস্টিক গুঁড়া হয়ে উঠে যায়',
    a: 'যেকোনো লিপস্টিক ইউজ করার আগে লিপস প্রোপারভাবে ময়েশ্চারাইজ করে তারপর লিপস্টিক এপ্লাই করতে হবে ম্যাম।\nএছাড়া Imagic এর প্রোডাক্টগুলো আমরা নিজেরা ইম্পোর্ট করে থাকি, প্রোডাক্টের গায়ে QR Code দেয়া আছে, আপনি চাইলে QR Code স্ক্যান করে অথেন্টিসিটি চেক করে নিতে পারবেন।',
    lesson: 'Short answer: moisturise lips first. Then the brand authenticity fact (Imagic: we import it ourselves, QR code on pack).',
  },
  {
    key: 'result-time', topic: 'how to',
    q: 'Skin1004 Tone Brightening Capsule Ampoule kotodin use korar por result pawa jabe?',
    alt: 'koto din e result pabo | কতদিনে ফল পাবো',
    a: 'যেকোনো স্কিনকেয়ার প্রোডাক্টের উপকারিতা আপনার ত্বকে কতটা স্যুট করছে তার ওপর নির্ভর করে, ম্যাম। প্রোডাক্টগুলো আপনার ত্বকে স্যুট করলে আশা করি আপনি ভালো ফলাফল পাবেন।',
    lesson: 'Never promise a timeline for results; it depends on how the product suits the skin.',
  },

  // ---- authenticity: general -------------------------------------------------
  {
    key: 'importer-sticker', topic: 'authenticity', free: true,
    q: 'apnader product e ki importer sticker deya ache?',
    alt: 'importer sticker ache | ইম্পোর্টার স্টিকার আছে কি',
    a: 'আমাদের প্রতিটা প্রোডাক্টে ইম্পোর্টার স্টিকার দেওয়া আছে ম্যাম।',
    lesson: 'Answer confidently and short: every product has an importer sticker (exception: Matrix — see its own entry). Don\'t send to the hotline.',
  },
  {
    key: 'how-to-know-original', topic: 'authenticity', free: true,
    q: 'apnader product original kina kivabe bujhbo?',
    alt: 'product authentic to | asol kina bujhbo kivabe | fake na to',
    a: 'Our all products are 100% original & authentic mam.\nAmader all product e importer sticker & bar code deya ache mam. Apni chaile delivery man er samne product check kore receive korte parben. Product related kono confusion face korle product intact rekhe delivery man samne thaka obosthay amader sathe contact korben mam.',
    lesson: 'Authenticity: 100% original, importer sticker + barcode on every product, customer can check in front of the delivery man; if in doubt keep it intact and contact us then.',
  },
  {
    key: 'authenticity-batch-expiry', topic: 'authenticity',
    q: 'I\'m interested in Dot & Key Cica Mattifying Sunscreen. Is it 100% authentic? Can you provide the batch number and expiry date? Is it from an authorized supplier?',
    alt: 'batch number expiry date diben | authorized supplier theke ana',
    a: 'আমাদের সকল প্রোডাক্ট ১০০% অরিজিনাল ও অথেনটিক, ম্যাম। ❤️\n\nআমরা অথরাইজড ডিস্ট্রিবিউটরের কাছ থেকে প্রোডাক্ট সংগ্রহ করে থাকি। প্রতিটি প্রোডাক্টের গায়ে ইমপোর্টার স্টিকার, ব্যাচ কোড, বারকোড, ম্যানুফ্যাকচারিং ডেট (MFG Date) এবং এক্সপায়ারি ডেট (EXP Date) দেওয়া রয়েছে, ম্যাম।\n\nDot & Key-এর প্রোডাক্টগুলো সম্পূর্ণ বৈধভাবে বাংলাদেশে আমদানি করা হয়, ইনটেক্ট সিলসহ এসে থাকে।',
    lesson: 'Batch/expiry questions: products come from authorised distributors and carry importer sticker, batch code, barcode, MFG and EXP dates. Reassure; don\'t say "we don\'t have that info".',
  },
  {
    key: 'fake-review-trust', topic: 'authenticity',
    q: 'Ami age apnader theke product niyechi, ekhon ek hyped page theke fake peyechi, review mixed dekhchi, tobu apnader theke nite chai.',
    alt: 'apnader page niye negative review dekhlam | অন্য পেজ থেকে ফেইক পেয়েছি | মিক্সড রিভিউ',
    a: 'আমাদের সকল প্রোডাক্ট ১০০% অথেন্টিক এবং অরিজিনাল। অনেকেই নিজেদের ব্যবসার প্রচার করতে গিয়ে আমাদের পেজ সম্পর্কে নেগেটিভ মন্তব্য করে থাকেন, যাদের আমাদের পেজ থেকে কোনো পারচেজ হিস্ট্রি থাকে না। আমরা আমাদের রিয়েল কাস্টমারদের কাছ থেকে নিয়মিত ফিডব্যাক নিই এবং কোনো ভ্যালিড ইস্যু থাকলে সমাধান করি।\nএছাড়াও আমাদের নিজস্ব ফিজিক্যাল শপ রয়েছে এবং ডেলিভারি ম্যানের সামনে পণ্য চেক করে নেওয়ার সুযোগ রয়েছে। আমরা বেশ কয়েকটি ব্র্যান্ডের ডিস্ট্রিবিউটর এবং আমাদের কোনো প্রোডাক্ট লোকালি সোর্স করা হয় না। তাই বিভ্রান্তিমূলক তথ্যে কনফিউজ না হওয়ার জন্য অনুরোধ করছি।',
    lesson: 'When trust is shaken by reviews or fakes elsewhere: thank them warmly, explain we have a physical shop, check-before-receive, distributor of several brands, nothing sourced locally.',
  },
  {
    key: 'price-lower', topic: 'authenticity',
    q: 'apnader ekhane product er price eto kom keno onno page e to beshi, product ti authentic?',
    alt: 'dam kom keno | অন্য পেজে দাম বেশি',
    a: 'প্রোডাক্টের কস্টিং প্রোফিট রেশিও সবার সেইম হয়ে থাকে না, তাই ভিন্ন ভিন্ন পেইজে ভিন্ন ভিন্ন প্রাইস ম্যাম।',
    lesson: 'Different price on other pages = different cost/profit ratio. Keep it short.',
  },
  {
    key: 'made-in-other-country', topic: 'authenticity',
    q: 'OMI Brotherhood Sun Bears Sunscreen to Japanese brand, made in Thailand likha keno?',
    alt: 'Maybelline Lumi matte Foundation website e India thakleo made in China keno | brand ek desher, made in onno desh',
    a: 'OMI sunscreen ti Japan thekei import hoye thake mam, but product er gaye made in Thailand likha thake, aro baki information Japani language e likha thake, and Japan er standard ei production kore. Product ti Japan er market e sell hoy; authentic OMI sun e made in Thailand likha thakbei mam.',
    lesson: 'Brand country ≠ factory country is normal (OMI: Japan import, made in Thailand; Maybelline Lumi Matte: Indian variant made in China). Explain calmly.',
  },
  {
    key: 'maybelline-china', topic: 'brand fact',
    q: 'Maybelline Lumi matte Foundation website e India thakleo made in China keno?',
    alt: 'maybelline made in china',
    a: 'Maybelline Lumi Matte Foundation টি ম্যানুফ্যাকচার China তে হয়েছে, তবে প্রোডাক্টটি Indian ভ্যারিয়েন্ট। আরো বিস্তারিত জানতে আমাদের হটলাইন নাম্বারে কল করতে পারেন ম্যাম। +8801775-423477 ✨',
    lesson: 'Maybelline Lumi Matte: made in China, Indian variant.', exact: true,
  },
  {
    key: 'new-batch-logo', topic: 'brand fact',
    q: 'Apnar theke ami 6 ta lip liner niyechi, 5 ta te BG lekha, eta ki original?',
    alt: 'packaging alada lagche | নতুন লোগো কেন',
    a: 'আমাদের সকল প্রোডাক্ট ১০০% অরিজিনাল ও অথেনটিক, ম্যাম।\nBeauty Glazed-এর প্রোডাক্টগুলো আমরা নিজেরাই ইমপোর্ট করে থাকি। এই লিপ লাইনারগুলো নতুন ব্যাচের প্রোডাক্ট, এতে BG লোগো দেওয়া রয়েছে, যা কোম্পানি থেকেই এভাবে এসেছে।\nপ্রোডাক্টের গায়ে QR Code দেয়া আছে, আপনি চাইলে QR code স্ক্যান করে অথেন্টিসিটি চেক করে রিসিভ করতে পারবেন ম্যাম।',
    lesson: 'Packaging/logo looks different: usually a new batch from the company. Beauty Glazed: we import it ourselves, QR code on pack.',
  },

  // ---- authenticity: brand facts --------------------------------------------
  { key: 'skin1004-qr', topic: 'brand fact', q: 'Skin1004 Hyalu-Cica Water-Fit Sun Serum authenticity check korbo kivabe?', alt: 'skin1004 asol kina', a: 'আমাদের সকল প্রোডাক্ট ১০০% অরিজিনাল এবং অথেন্টিক ম্যাম।\nআমাদের প্রতিটি প্রোডাক্টে ইমপোর্টার স্টিকার এবং বারকোড দেয়া আছে, এবং Skin1004 Hyalu Cica Water Fit Sun Serum 50 ml-টিতে অফিসিয়াল QR code দেয়া আছে, আপনি চাইলে চেক করতে পারবেন ম্যাম। বিস্তারিত জানতে: +8801775-423477', lesson: 'Skin1004: official QR code on the pack plus importer sticker and barcode.' },
  { key: 'celimax-qr', topic: 'brand fact', q: 'Celimax The Vita A Retinal Shot Tightening Booster authenticity kivabe ber korbo?', alt: 'celimax original kina', a: 'Celimax The Vita A Retinal Shot Tightening Booster - 15ml e official QR code deya thake mam, apni QR code scan kore authenticity check kore nite parben mam.', lesson: 'Celimax: official QR code — scan to verify.' },
  { key: 'dabo-hidden-tag', topic: 'brand fact', q: 'Dabo All In One Black Snail Repair Cream authenticity kivabe ber korbo?', alt: 'dabo asol kina', a: 'Dabo er product amra Bangladesh er ekmatro distributor Koba International theke source kore thaki.\nDabo All In One Black Snail Repair Cream 100 gm e security code deya ache mam, Hidden Tag app theke QR code scan kore authenticity check kore nite parben mam.', lesson: 'Dabo: sourced from Koba International (sole BD distributor); security code — verify with the Hidden Tag app.' },
  { key: 'matrix-transcom', topic: 'brand fact', q: 'Matrix Shampoo te importer sticker deya ache?', alt: 'matrix original kina', a: '"Matrix" ব্র্যান্ডের বাংলাদেশে একমাত্র ডিস্ট্রিবিউটর "Transcom Distribution Company Limited"। আমরা Matrix-এর প্রোডাক্টগুলো সরাসরি Transcom থেকে পারচেজ করে থাকি।\nMatrix-এর Shampoo-তে Importer sticker দেয়া নেই, প্রোডাক্টের গায়ে Bar Code ও BSTI Seal দেয়া আছে, আপনি চাইলে চেক করে নিতে পারবেন ম্যাম।', lesson: 'Matrix: bought from Transcom (sole distributor); NO importer sticker, but barcode + BSTI seal.' },
  { key: 'cerave-expiry', topic: 'brand fact', q: 'cerave er product e expire date deya nei keno?', alt: 'cerave expiry kothay', a: 'CeraVe er product gulo te expire date mention kora thake na mam. checkfresh.com er maddhome product er batch code diye manufacture date ber kore nite parben, manufacture date theke 3 years projonto use korte parben.', lesson: 'CeraVe: no printed expiry; batch code on checkfresh.com gives the MFG date; usable 3 years from it.' },
  { key: 'sheglam-expiry', topic: 'brand fact', q: 'Sheglam product er exp date koto?', alt: 'sheglam expiry', a: 'Sheglam প্রোডাক্টগুলোতে এক্সপায়ার ডেট মেনশন করা থাকে না। প্রোডাক্টগুলোর মেয়াদ আফটার ওপেনিং (PAO) হিসেবে হয়ে থাকে ম্যাম।', lesson: 'Sheglam: no printed expiry; shelf life is counted after opening (PAO).' },

  // ---- fixed store facts (exact text, answered even after the limit) -------
  {
    key: 'delivery-charge', topic: 'fact', exact: true, free: true,
    q: 'apnader delivery charge koto?',
    alt: 'dhakar baire delivery charge | শিপিং চার্জ কত | free delivery kobe',
    a: '🗺 Inside Dhaka (Cash On Delivery)\n🚛 Delivery Charge: 60 TK\n\n🗺 Outside Dhaka (Cash On Delivery)\n🚛 Delivery Charge: 100 TK\n\n📌 1200 TK+ purchase e delivery charge free all over Bangladesh',
    lesson: 'Delivery: 60 TK inside Dhaka, 100 TK outside, free over 1200 TK, cash on delivery.',
  },
  {
    key: 'shop-address', topic: 'fact', exact: true, free: true,
    q: 'shop address',
    alt: 'apnader dokan kothay | physical shop ache | ঠিকানা দিন | store kothay',
    a: '📍 ঠিকানাঃ Perfecto, Shop No: 14/B (2nd Floor) Rankin Square Market (Mens World Building), 32 Rankin Street, Wari, Dhaka\n\n🗺 গুগল ম্যাপঃ https://maps.app.goo.gl/XXVij4ECWxTn8KhS9\n\n📱 Mobile number (WhatsApp) - 01318634834\n\n🕚 সময়ঃ 10:30am - 10:00pm, আমাদের কোনো সাপ্তাহিক বন্ধ নেই।',
    lesson: 'We DO have a physical shop at Rankin Square, Wari. Give address, map, WhatsApp and hours.',
  },
  {
    key: 'bkash', topic: 'fact', exact: true, free: true,
    q: 'apnader bkash number din',
    alt: 'bkash e payment korbo | বিকাশ নাম্বার',
    a: 'Bkash Merchant - 01780303004',
    lesson: 'bKash merchant number is 01780303004.',
  },
  {
    key: 'mobile-app', topic: 'fact', exact: true, free: true,
    q: 'apnader app ache?',
    alt: 'android app | অ্যাপ আছে',
    a: 'Ji mam, amader app ache.\nhttps://play.google.com/store/apps/details?id=com.perfecto.app',
    lesson: 'We have an Android app (Play Store link).',
  },
  {
    key: 'return-policy', topic: 'fact', exact: true, free: true,
    q: 'apnader return & refund policy ki?',
    alt: 'ferot dewa jabe | রিফান্ড পলিসি | product suit na korle return',
    a: 'Return & Refund Policy:\n\nপার্সেল পাওয়ার পরে কোনো সমস্যা/কমপ্লেইন থাকলে করণীয়ঃ\n1. কোনো প্রোডাক্ট মিসিং থাকলে কিংবা ভুল প্রোডাক্ট পেলে ডেলিভারি ম্যান সামনে থাকা অবস্থায় আমাদের সাথে কন্টাক্ট করতে হবে এবং আমাদের ফেইসবুক পেইজের ইনবক্সে কমপ্লেইনটি জানিয়ে রাখতে হবে। (Hotline: +8801775423477)\n2. ড্যামেজ, ডিফেক্টিভ বা ভুল পণ্য পেলে প্রোডাক্টটি ইনটেক্ট রেখে আমাদের সাথে কন্টাক্ট করতে হবে এবং প্রোডাক্টের পিকচার আমাদের ইনবক্সে দিতে হবে।\n\nযে যে কারণে রিফান্ড/রিটার্ন করতে পারবেন নাঃ\n1. প্রোডাক্টের সিল খুলে ফেললে বা প্রোডাক্টটি স্যুট না করলে এক্সচেঞ্জ বা রিফান্ডের সুযোগ নেই।\n2. সোয়াচ করা/ব্যবহার করা প্রোডাক্টের ক্ষেত্রে এক্সচেঞ্জ বা রিফান্ডের সুযোগ নেই।',
    lesson: 'Return policy: complain while the delivery man is present (missing/wrong item) or keep damaged items intact with photos; no return once the seal is opened, used, swatched or if it didn\'t suit.',
  },
  {
    key: 'unboxing-video', topic: 'fact',
    q: 'Delivery man er shamne parcel check korte na parle product e kono problem hole tokhon ki korbo?',
    alt: 'pore problem dekhle ki korbo | পার্সেল পরে খুলেছি',
    a: 'সেক্ষেত্রে আপনার পার্সেলটির একটি আনপ্যাকিং ভিডিও করবেন ম্যাম।',
    lesson: 'If they can\'t check in front of the delivery man, ask them to record an unboxing video.',
  },
  {
    key: 'restock', topic: 'fact', free: true,
    q: 'apnader product kobe stock e anben?',
    alt: 'stock out kobe asbe | কবে স্টকে আসবে',
    a: 'Stock in hole page e update diye deya hobe mam.',
    lesson: 'Restock: we post an update on the page when it is back. No dates.',
  },
];
