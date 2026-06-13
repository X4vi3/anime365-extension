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
    "version": "0.2.3",
    "pkgPath": "anime/src/ru/anime365.js"
}];

// Зашитый идентификатор API-клиента (как OAuth client_id, не секрет).
// Дублирует значение по умолчанию настройки anime365_app, чтобы логин работал
// даже если на Android чтение настроек падает (см. getPref ниже).
const ANIME365_DEFAULT_APP = "app-d9e50633b507a35745f89574";
const ANIME365_DEFAULT_BASE = "https://smotret-anime.online";

class DefaultExtension extends MProvider {
    constructor() {
        super();
        this.client = new Client();
        this.pageSize = 20;
    }

    // Устойчивое чтение настройки. На Android-движке AnymeX (flutter_qjs) мост
    // не может вычислить значение по умолчанию, если пользователь не сохранял
    // настройку руками, и бросает "Error when getting source preference".
    // Поэтому любой сбой/пустое значение → жёсткий fallback, а не падение.
    getPref(key, fallback) {
        let v;
        try {
            v = new SharedPreferences().get(key);
        } catch (_) {
            return fallback;
        }
        if (v === null || v === undefined) return fallback;
        if (typeof v === "string" && v.length === 0) return fallback;
        if (Array.isArray(v) && v.length === 0) return fallback;
        return v;
    }

    getBaseUrl() {
        return this.getPref("anime365_base_url", ANIME365_DEFAULT_BASE).trim().replace(/\/+$/, "");
    }

    getHeaders() {
        return {
            "User-Agent": "Mangayomi-Anime365-Extension/0.2.3",
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
        const lang = this.getPref("anime365_title_lang", "romaji");
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
        return this.getPref("anime365_token", "").trim().length > 0;
    }

    async getToken(forceRefresh) {
        const prefs = new SharedPreferences();
        const manual = this.getPref("anime365_token", "").trim();
        if (manual.length > 0) return manual;

        const app = this.getPref("anime365_app", ANIME365_DEFAULT_APP).trim() || ANIME365_DEFAULT_APP;
        const email = this.getPref("anime365_email", "").trim();
        const password = this.getPref("anime365_password", "");
        if (!email || !password) {
            throw new Error("Anime365: заполните e-mail и пароль в настройках источника (или вставьте access_token напрямую)");
        }

        // кэш токена живёт в строковом хранилище — оно не падает на Android
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

    getMinHeight() {
        return parseInt(this.getPref("anime365_min_height", "0")) || 0;
    }

    filterTranslations(translations) {
        const kinds = this.getPref("anime365_translation_kinds", ["voice", "sub"]);
        const langs = this.getPref("anime365_translation_langs", ["ru"]);
        const max = parseInt(this.getPref("anime365_max_translations", "15"));
        const minHeight = this.getMinHeight();
        let list = (translations || []).filter(t => t.isActive !== 0);
        list = list.filter(t => {
            const kind = this.normalizeKind(t);
            if (!kinds.includes(kind)) return false;
            // отбрасываем перевод, чьё максимальное разрешение ниже порога —
            // заодно экономим запросы embed
            if (minHeight > 0 && (t.height || 0) < minHeight) return false;
            if (kind === "raw") return true; // оригинал не фильтруем по языку
            return langs.includes(this.normalizeLang(t));
        });
        // порядок API — по priority (рейтинг Anime365), поэтому просто обрезаем хвост
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
        const minHeight = this.getMinHeight();
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
                    const height = stream.height || 0;
                    if (minHeight > 0 && height < minHeight) continue; // прячем низкое разрешение
                    videos.push({
                        url: streamUrl,
                        originalUrl: streamUrl,
                        quality: `${label} • ${height}p`,
                        subtitles,
                        headers: this.getHeaders(),
                        _height: height,            // для сортировки (мост игнорирует лишние поля)
                        _priority: t.priority || 0, // рейтинг Anime365
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
        const mode = this.getPref("anime365_sort", "quality");
        return videos.sort((a, b) => {
            const ah = a._height || 0, bh = b._height || 0;
            const ap = a._priority || 0, bp = b._priority || 0;
            if (mode === "priority") {
                // популярность Anime365, при равенстве — выше разрешение
                return bp !== ap ? bp - ap : bh - ah;
            }
            // по качеству: выше разрешение, при равенстве — выше приоритет
            return bh !== ah ? bh - ah : bp - ap;
        });
    }

    getSourcePreferences() {
        return [
            {
                key: "anime365_email",
                editTextPreference: {
                    title: "E-mail аккаунта Anime365",
                    summary: "Обязательно. Почта от аккаунта с активной подпиской",
                    value: "",
                    dialogTitle: "E-mail",
                    dialogMessage: "",
                },
            },
            {
                key: "anime365_password",
                editTextPreference: {
                    title: "Пароль аккаунта Anime365",
                    summary: "Обязательно. Хранится локально, используется только для получения токена",
                    value: "",
                    dialogTitle: "Пароль",
                    dialogMessage: "",
                },
            },
            {
                key: "anime365_app",
                editTextPreference: {
                    title: "Идентификатор API-клиента (app)",
                    summary: "Уже заполнено — менять не нужно. Своё значение создаётся на /api-clients вашего зеркала",
                    value: ANIME365_DEFAULT_APP,
                    dialogTitle: "app",
                    dialogMessage: "Идентификатор API-клиента (как OAuth client_id, не секретный)",
                },
            },
            {
                key: "anime365_token",
                editTextPreference: {
                    title: "Access token (необязательно)",
                    summary: "Оставьте пустым. Нужен только если хотите входить без e-mail и пароля",
                    value: "",
                    dialogTitle: "access_token",
                    dialogMessage: "Если указан — логин и пароль не используются. Токен можно получить запросом /api/accessToken?app=... в браузере, где вы вошли на сайт",
                },
            },
            {
                key: "anime365_base_url",
                editTextPreference: {
                    title: "Зеркало сайта",
                    summary: "Например: https://smotret-anime.online, https://anime-365.ru, https://smotret-anime.app",
                    value: ANIME365_DEFAULT_BASE,
                    dialogTitle: "Адрес зеркала",
                    dialogMessage: "Без слэша на конце",
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
            {
                key: "anime365_min_height",
                listPreference: {
                    title: "Минимальное разрешение",
                    summary: "Скрывать варианты ниже выбранного качества",
                    valueIndex: 0,
                    entries: ["Любое", "720p и выше", "1080p и выше", "1440p и выше", "Только 2160p"],
                    entryValues: ["0", "720", "1080", "1440", "2160"],
                },
            },
            {
                key: "anime365_sort",
                listPreference: {
                    title: "Сортировка вариантов",
                    summary: "Как упорядочить список озвучек/качеств",
                    valueIndex: 0,
                    entries: ["По качеству (выс→низ)", "По популярности (Anime365)"],
                    entryValues: ["quality", "priority"],
                },
            },
        ];
    }
}
