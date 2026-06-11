const mangayomiSources = [{
    "name": "Anime365",
    "id": 3653650001,
    "lang": "ru",
    "baseUrl": "https://smotret-anime.online",
    "apiUrl": "",
    "iconUrl": "https://smotret-anime.online/apple-touch-icon.png",
    "typeSource": "single",
    "itemType": 1,
    "isNsfw": false,
    "version": "0.2.0",
    "pkgPath": "anime/src/ru/anime365.js"
}];

class DefaultExtension extends MProvider {
    constructor() {
        super();
        this.client = new Client();
        this.pageSize = 20;
    }

    getPreference(key) {
        return new SharedPreferences().get(key);
    }

    getBaseUrl() {
        const url = (this.getPreference("anime365_base_url") || "https://smotret-anime.online").trim();
        return url.replace(/\/+$/, "");
    }

    getHeaders() {
        return {
            "User-Agent": "Mangayomi-Anime365-Extension/0.2.0",
        };
    }

    absUrl(url) {
        if (!url) return url;
        if (url.startsWith("http")) return url;
        return this.getBaseUrl() + (url.startsWith("/") ? url : "/" + url);
    }

    async apiRequest(path) {
        const res = await this.client.get(`${this.getBaseUrl()}/api${path}`, this.getHeaders());
        const json = JSON.parse(res.body);
        if (json.error) {
            throw new Error(`Anime365: ${json.error.message || ("ошибка " + json.error.code)}`);
        }
        return json.data;
    }

    pickTitle(titles) {
        if (!titles) return "Без названия";
        // дефолт — ромадзи: AnymeX матчит тайтлы с AniList фаззи-сравнением названий,
        // кириллица даёт нулевое сходство и «No servers available»
        const lang = this.getPreference("anime365_title_lang") || "romaji";
        return titles[lang] || titles.romaji || titles.en || titles.ru || Object.values(titles)[0];
    }

    mapSeriesList(items) {
        return (items || []).map(s => ({
            name: this.pickTitle(s.titles),
            imageUrl: s.posterUrlSmall || s.posterUrl || "",
            link: `/catalog/${s.id}`,
        }));
    }

    async seriesPage(extraQuery, page) {
        const offset = (page - 1) * this.pageSize;
        const data = await this.apiRequest(
            `/series?limit=${this.pageSize}&offset=${offset}&fields=id,titles,posterUrl,posterUrlSmall${extraQuery}`
        );
        const list = this.mapSeriesList(data);
        return { list, hasNextPage: list.length === this.pageSize };
    }

    async getPopular(page) {
        // дефолтная сортировка каталога — по рейтингу
        return await this.seriesPage("", page);
    }

    async getLatestUpdates(page) {
        // онгоинги, которые выходят прямо сейчас
        return await this.seriesPage("&isAiring=1", page);
    }

    async search(query, page, filters) {
        // поиск anime365 не находит ничего по типографским апострофам/кавычкам,
        // а AniList-названия из AnymeX приходят именно с U+2019 (Akebi’s …)
        const q = String(query)
            .replace(/[‘’ʼ‛`´]/g, "'")
            .replace(/[“”«»]/g, '"')
            .replace(/\s+/g, " ")
            .trim();
        return await this.seriesPage(`&query=${encodeURIComponent(q)}`, page);
    }

    seriesIdFromLink(url) {
        const m = String(url).match(/(\d+)\/?$/);
        if (!m) throw new Error(`Anime365: не удалось определить id тайтла из "${url}"`);
        return m[1];
    }

    toEpochMs(dateTimeStr) {
        if (!dateTimeStr) return null;
        const ms = new Date(dateTimeStr.replace(" ", "T")).valueOf();
        return isNaN(ms) ? null : String(ms);
    }

    async getDetail(url) {
        const id = this.seriesIdFromLink(url);
        const s = await this.apiRequest(
            `/series/${id}?fields=id,titles,posterUrl,descriptions,genres,isAiring,numberOfEpisodes,season,year,typeTitle,myAnimeListScore,episodes`
        );

        let description = "";
        if (s.descriptions && s.descriptions.length > 0) {
            description = s.descriptions[0].value || "";
        }
        const meta = [];
        if (s.typeTitle) meta.push(`Тип: ${s.typeTitle}`);
        if (s.season) meta.push(`Сезон: ${s.season}`);
        if (s.numberOfEpisodes) meta.push(`Эпизодов: ${s.numberOfEpisodes}`);
        if (s.myAnimeListScore && Number(s.myAnimeListScore) > 0) meta.push(`Оценка MAL: ${s.myAnimeListScore}★`);
        if (meta.length > 0) {
            description = description ? `${description}\n\n${meta.join("\n")}` : meta.join("\n");
        }

        const episodes = (s.episodes || [])
            .filter(e => e.isActive !== 0 && e.episodeType !== "preview")
            .sort((a, b) => parseFloat(a.episodeInt) - parseFloat(b.episodeInt))
            .map(e => ({
                name: e.episodeTitle ? `${e.episodeFull} — ${e.episodeTitle}` : (e.episodeFull || `${e.episodeInt} серия`),
                url: JSON.stringify({ episodeId: e.id }),
                dateUpload: this.toEpochMs(e.firstUploadedDateTime),
            }))
            .reverse();

        return {
            name: this.pickTitle(s.titles),
            imageUrl: s.posterUrl || "",
            description,
            genre: (s.genres || []).map(g => g.title),
            status: s.isAiring === 1 ? 0 : 1,
            episodes,
        };
    }

    hasManualToken() {
        return ((this.getPreference("anime365_token") || "").trim()).length > 0;
    }

    async getToken(forceRefresh) {
        const prefs = new SharedPreferences();
        const manual = (prefs.get("anime365_token") || "").trim();
        if (manual.length > 0) return manual;

        const app = (prefs.get("anime365_app") || "").trim();
        const email = (prefs.get("anime365_email") || "").trim();
        const password = prefs.get("anime365_password") || "";
        if (!app || !email || !password) {
            throw new Error("Anime365: заполните app, email и пароль в настройках расширения (или вставьте access_token напрямую)");
        }

        const credSig = `${app}|${email}|${password}`;
        if (!forceRefresh && prefs.getString("anime365_cached_cred", "") === credSig) {
            const cached = prefs.getString("anime365_cached_token", "");
            if (cached.length > 0) return cached;
        }

        const data = await this.apiRequest(
            `/login?app=${encodeURIComponent(app)}&email=${encodeURIComponent(email)}&password=${encodeURIComponent(password)}`
        );
        const token = data.access_token;
        if (!token) throw new Error("Anime365: сервер не вернул access_token");
        prefs.setString("anime365_cached_cred", credSig);
        prefs.setString("anime365_cached_token", token);
        return token;
    }

    // typeKind в API: voice, sub, raw, а «озвучка на другом языке» приезжает
    // разломанной на typeKind=voiceOth + typeLang=er — нормализуем
    normalizeKind(t) {
        const k = (t.typeKind || "").toLowerCase();
        if (k.startsWith("voice")) return "voice";
        if (k.startsWith("sub")) return "sub";
        if (k === "raw") return "raw";
        return "voice";
    }

    normalizeLang(t) {
        if ((t.typeKind || "").toLowerCase() === "voiceoth") return "other";
        const l = (t.typeLang || "").toLowerCase();
        return ["ru", "en", "ja"].includes(l) ? l : "other";
    }

    filterTranslations(translations) {
        const kinds = this.getPreference("anime365_translation_kinds") || ["voice", "sub"];
        const langs = this.getPreference("anime365_translation_langs") || ["ru"];
        const max = parseInt(this.getPreference("anime365_max_translations") || "15");
        let list = (translations || []).filter(t => t.isActive !== 0);
        list = list.filter(t => {
            const kind = this.normalizeKind(t);
            if (!kinds.includes(kind)) return false;
            if (kind === "raw") return true; // оригинал не фильтруем по языку
            return langs.includes(this.normalizeLang(t));
        });
        // порядок API — по приоритету, поэтому просто обрезаем хвост
        if (max > 0) list = list.slice(0, max);
        return list;
    }

    translationLabel(t) {
        const kindNames = { voice: "Озвучка", sub: "Субтитры", raw: "Оригинал" };
        const kind = kindNames[this.normalizeKind(t)] || "Перевод";
        let authors = (t.authorsSummary || "").trim();
        if (!authors) authors = (t.authorsList || []).join(", ").trim();
        const lang = this.normalizeLang(t);
        const langSuffix = this.normalizeKind(t) !== "raw" && lang !== "ru" ? ` [${lang}]` : "";
        return authors ? `${kind}${langSuffix}: ${authors}` : `${kind}${langSuffix}`;
    }

    async getVideoList(url) {
        const episodeId = JSON.parse(url).episodeId;

        const episode = await this.apiRequest(`/episodes/${episodeId}`);
        const translations = this.filterTranslations(episode.translations);
        if (translations.length === 0) {
            throw new Error("Anime365: для этой серии нет переводов выбранных типов (проверьте настройки расширения)");
        }

        let result = await this.fetchEmbeds(translations, await this.getToken(false));
        if (result.videos.length === 0 && result.authError && !this.hasManualToken()) {
            // кэшированный токен мог протухнуть — перелогиниваемся один раз
            result = await this.fetchEmbeds(translations, await this.getToken(true));
        }

        if (result.videos.length === 0) {
            if (result.authError) {
                throw new Error(`Anime365: ${result.authError} — проверьте логин и активность подписки в настройках источника`);
            }
            throw new Error("Anime365: не удалось получить ни одной ссылки на видео");
        }
        return this.sortVideos(result.videos);
    }

    async fetchEmbeds(translations, token) {
        let authError = null;
        const groups = await Promise.all(translations.map(async (t) => {
            try {
                const res = await this.client.get(
                    `${this.getBaseUrl()}/api/translations/embed/${t.id}?access_token=${encodeURIComponent(token)}`,
                    this.getHeaders()
                );
                const json = JSON.parse(res.body);
                if (json.error) {
                    if (json.error.code === 403) authError = json.error.message || "доступ запрещён";
                    return [];
                }
                const embed = json.data;
                const subtitles = [];
                if (embed.subtitlesUrl) subtitles.push({ file: this.absUrl(embed.subtitlesUrl), label: "ASS" });
                if (embed.subtitlesVttUrl) subtitles.push({ file: this.absUrl(embed.subtitlesVttUrl), label: "WebVTT" });
                const label = this.translationLabel(t);
                const videos = [];
                for (const stream of (embed.stream || [])) {
                    const streamUrl = (stream.urls || [])[0];
                    if (!streamUrl) continue;
                    videos.push({
                        url: streamUrl,
                        originalUrl: streamUrl,
                        quality: `${label} • ${stream.height}p`,
                        subtitles,
                        headers: this.getHeaders(),
                    });
                }
                return videos;
            } catch (_) {
                return [];
            }
        }));

        return { videos: groups.flat(), authError };
    }

    sortVideos(videos) {
        const q = this.getPreference("anime365_quality") || "1080";
        return videos.sort((a, b) => {
            const am = a.quality.includes(`${q}p`) ? 1 : 0;
            const bm = b.quality.includes(`${q}p`) ? 1 : 0;
            return bm - am;
        });
    }

    getSourcePreferences() {
        return [
            {
                key: "anime365_base_url",
                editTextPreference: {
                    title: "Зеркало сайта",
                    summary: "Например: https://smotret-anime.online, https://anime-365.ru, https://smotret-anime.app",
                    value: "https://smotret-anime.online",
                    dialogTitle: "Адрес зеркала",
                    dialogMessage: "Без слэша на конце",
                },
            },
            {
                key: "anime365_app",
                editTextPreference: {
                    title: "Идентификатор API-клиента (app)",
                    summary: "Создаётся один раз на странице /api-clients вашего зеркала",
                    value: "",
                    dialogTitle: "app",
                    dialogMessage: "Идентификатор, полученный на странице создания API-клиента",
                },
            },
            {
                key: "anime365_email",
                editTextPreference: {
                    title: "E-mail аккаунта Anime365",
                    summary: "",
                    value: "",
                    dialogTitle: "E-mail",
                    dialogMessage: "",
                },
            },
            {
                key: "anime365_password",
                editTextPreference: {
                    title: "Пароль аккаунта Anime365",
                    summary: "Хранится локально, используется только для получения access_token",
                    value: "",
                    dialogTitle: "Пароль",
                    dialogMessage: "",
                },
            },
            {
                key: "anime365_token",
                editTextPreference: {
                    title: "Access token (вручную, опционально)",
                    summary: "Если указан — логин и пароль не используются",
                    value: "",
                    dialogTitle: "access_token",
                    dialogMessage: "Токен можно получить запросом /api/accessToken?app=... в браузере, где вы вошли на сайт",
                },
            },
            {
                key: "anime365_title_lang",
                listPreference: {
                    title: "Язык названий",
                    summary: "Внимание: русские названия ломают автоматический подбор тайтла в AnymeX",
                    valueIndex: 1,
                    entries: ["Русский", "Ромадзи", "English"],
                    entryValues: ["ru", "romaji", "en"],
                },
            },
            {
                key: "anime365_translation_kinds",
                multiSelectListPreference: {
                    title: "Типы переводов",
                    summary: "Какие переводы показывать в списке видео",
                    entries: ["Озвучка", "Субтитры", "Оригинал"],
                    entryValues: ["voice", "sub", "raw"],
                    values: ["voice", "sub"],
                },
            },
            {
                key: "anime365_translation_langs",
                multiSelectListPreference: {
                    title: "Языки переводов",
                    summary: "К оригиналу (raw) не применяется",
                    entries: ["Русский", "English", "Японский", "Другие"],
                    entryValues: ["ru", "en", "ja", "other"],
                    values: ["ru"],
                },
            },
            {
                key: "anime365_max_translations",
                listPreference: {
                    title: "Максимум переводов на серию",
                    summary: "Сколько переводов запрашивать при открытии серии (меньше — быстрее)",
                    valueIndex: 2,
                    entries: ["5", "10", "15", "25", "Все"],
                    entryValues: ["5", "10", "15", "25", "0"],
                },
            },
        ];
    }
}
