import { Component, Injector, OnInit, Input, HostListener } from '@angular/core'
import { BaseTabComponent, ConfigService, ProfilesService, PartialProfile, Profile, HostAppService, SelectorService, PlatformService, TranslateService, ProfileProvider } from 'tabby-core'
import { NgbModal } from '@ng-bootstrap/ng-bootstrap'
declare const require: any
import FuzzySearch from 'fuzzy-search'
import { exec } from 'child_process'

// type nestedGroup = {
//     name: string | null,
//     profiles: PartialProfile<Profile>[] | null,
//     subgroups: { [subgroup: string]: nestedGroup }
// }

/** @hidden */
@Component({
    selector: 'profile-selector',
    template: require('./profileSelector.component.html'),
    styles: [`
        .selector-card {
            width: 300px;
            cursor: pointer;
            transition: all 0.2s;
            text-decoration: none;
            color: inherit;
            justify-content: flex-start;
            gap: 8px;
        }
        .selector-card:hover {
            filter: brightness(1.2);
            background-color: rgba(255, 255, 255, 0.1);
            box-shadow: 0 4px 8px rgba(0, 0, 0, 0.2);
        }

        .selector-card_icon {
            font-size: 20px;
            width: 40px;
            height: 100%;
            padding: .6rem;
        }

        .selector-card_title {
            text-overflow: ellipsis;
            max-width: 230px;
            overflow: hidden;
            white-space: nowrap;

        }

        .selector-card_content {
            flex: 1 1 auto;
            min-width: 0;
        }

        .status-dot {
            width: 12px;
            height: 12px;
            border-radius: 50%;
            display: inline-block;
            border: 2px solid rgba(255, 255, 255, 0.4);
            box-shadow: 0 0 4px rgba(0, 0, 0, 0.4);
            cursor: pointer;
            position: relative;
            flex: 0 0 12px;
        }

        .status-unknown { background-color: #8c8c8c; }
        .status-testing { background-color: #f59e0b; }
        .status-down { background-color: #ef4444; }
        .status-up { background-color: #22c55e; }
        .status-disabled { opacity: 0.65; }
        .status-disabled::after {
            content: '';
            position: absolute;
            width: 16px;
            height: 2px;
            background: rgba(255, 255, 255, 0.8);
            top: 50%;
            left: 50%;
            transform: translate(-50%, -50%) rotate(45deg);
        }

        .status-latency {
            font-size: 10px;
            opacity: 0.7;
            margin-right: 6px;
            min-width: 40px;
            text-align: right;
        }

        .status-tile {
            display: inline-flex;
            align-items: center;
            justify-content: flex-end;
            gap: 6px;
            width: 64px;
            flex: 0 0 64px;
            padding: 4px 6px;
            border-radius: 10px;
            background: rgba(255, 255, 255, 0.08);
            border: 1px solid rgba(255, 255, 255, 0.12);
        }
    `]
})
export class ProfileSelectorComponent extends BaseTabComponent implements OnInit {
    profiles: PartialProfile<Profile>[] = [];
    @Input() search: string = '';
    groups: string[] = [];
    groupedProfiles: { [group: string]: PartialProfile<Profile>[] } = {};
    private injectorRef: Injector

    constructor(
        public config: ConfigService,
        public profilesService: ProfilesService,
        private ngbModal: NgbModal,
        injector: Injector,
    ) {
        super(injector)
        this.icon = 'fas fa-grip'
        this.injectorRef = injector
        this.title = 'Select Profile'
    }

    // context menu state
    contextMenuVisible = false
    contextMenuX = 0
    contextMenuY = 0
    contextMenuProfile: PartialProfile<Profile> | null = null

    // ping status state
    pingStatus: { [key: string]: 'unknown' | 'testing' | 'up' | 'down' } = {}
    pingTimers: { [key: string]: any } = {}
    pingIntervalMs = 60000
    pingTimeoutMs = 2000
    pingEnabled: { [key: string]: boolean } = {}
    pingLatencyMs: { [key: string]: number | null } = {}

    #groupOrder(g: string): string {
        if (g === 'Recent') return '0000'
        if (g === 'Favorites' || g === 'Starred' || g === 'Favourites' || g === 'Favorite' || g === 'Favourited') return '0001'
        if (g === 'Ungrouped') return 'ZZZX'
        if (g.startsWith('Imported ')) return 'ZZZY'
        if (g === 'Built-in') return 'ZZZZ'
        return g
    }

    #parseColor(color: string): { r: number, g: number, b: number } | null {
        if (color.startsWith('#')) return {
            r: parseInt(color.slice(1, 3), 16),
            g: parseInt(color.slice(3, 5), 16),
            b: parseInt(color.slice(5, 7), 16)
        }

        if (color.startsWith('rgb')) {
            const parts = color.replace(/rgba?\(/, '').replace(')', '').split(',').map(p => p.trim())
            if (parts.length >= 3) return {
                r: parseInt(parts[0], 10),
                g: parseInt(parts[1], 10),
                b: parseInt(parts[2], 10)
            }
        }

        return null
    }

    #getIconHtml(profile: PartialProfile<Profile>): string {
        if (!profile.icon) return `<i class="fa fa-user text-white"></i>`
        if (profile.icon.startsWith('<')) return profile.icon
        if (profile.icon.startsWith('data:') || profile.icon.startsWith('http')) return `<img src="${profile.icon}" class="h-100" />`
        return `<i class="fa ${profile.icon} text-white"></i>`
    }

    #tintProfileColor(profile: PartialProfile<Profile>, tint: number = 1.0, important: boolean = false, defaultColor: string = 'inherit'): string {
        // tint the color for light/dark variants
        if (profile.color) {
            const rgb = this.#parseColor(profile.color)
            if (rgb) {
                let { r, g, b } = rgb
                if (tint < 1.0) {
                    r = Math.round(r * tint + 255 * (1 - tint))
                    g = Math.round(g * tint + 255 * (1 - tint))
                    b = Math.round(b * tint + 255 * (1 - tint))
                } else if (tint > 1.0) {
                    const itint = tint - 1.0
                    r = Math.round(r * (1 - itint))
                    g = Math.round(g * (1 - itint))
                    b = Math.round(b * (1 - itint))
                }
                return `rgb(${r}, ${g}, ${b})${important ? ' !important' : ''}`
            }

            // assume valid css color string
            return profile.color + (important ? ' !important' : '')
        }

        // default color
        return `${defaultColor} ${important ? '!important' : ''}`
    }

    #doGroupProfiles(profiles: PartialProfile<Profile>[] = this.profiles) {
        console.log('doGroupProfiles', profiles)
        if (profiles.length === 0) {
            this.groups = []
            this.groupedProfiles = {}
            return;
        }

        this.groups = Array.from(new Set(profiles.map(p => p.group).filter(g => !!g))).sort((a, b) => this.#groupOrder(a!).localeCompare(this.#groupOrder(b!))) as string[];

        // create groupedProfiles
        this.groupedProfiles = {}
        for (const group of this.groups) {
            this.groupedProfiles[group] = profiles.filter(p => p.group === group)
        }
    }

    async #initProfiles() {
            let profiles: PartialProfile<Profile>[] = []
            let recentProfiles: PartialProfile<Profile>[] = []
            try {
                const p = await this.profilesService.getProfiles()
                profiles = Array.isArray(p) ? p : []
            } catch (e) {
                console.error('[ProfileSelector] error getting profiles', e)
                profiles = []
            }

            console.log('[ProfileSelector] config groups:', (this.config.store as any).groups)

            try {
                const r = this.profilesService.getRecentProfiles()
                recentProfiles = Array.isArray(r) ? r.map(x => ({ ...x, group: 'Recent' })) : []
            } catch (e) {
                console.error('[ProfileSelector] error getting recent profiles', e)
                recentProfiles = []
            }

        // clean up profiles list
        for (const _profile of [...profiles, ...recentProfiles]) {

            // get selectorOptionForProfile to ensure it's valid
            let option: any = {}
            try {
                option = this.profilesService.selectorOptionForProfile(_profile) || {}
            } catch (e) {
                console.error('[ProfileSelector] error getting selectorOptionForProfile', e, _profile)
                option = {}
            }

            const profile = {
                ...option,
                ..._profile,
            } as PartialProfile<Profile> & {
                borderColor?: string
                iconHtml?: string
            }

            profile.borderColor = this.#tintProfileColor(profile, 1.1, true, 'var(--theme-secondary-less-2)')
            profile.iconHtml = this.#getIconHtml(profile)


            // ensure all profiles have a name
            if (!profile.name) {
                profile.name = this.profilesService.getDescription(profile) || 'Unnamed'
            }

            // add non-grouped builtin profiles to 'Built-in' group
            if (!profile.group && profile.isBuiltin) {
                profile.group = 'Built-in'
            }

            // normalize group: support when group is an object, numeric id, or uuid -> convert to group name
            if (profile.group) {
                // if group is an object like { id, name }
                if (typeof profile.group === 'object') {
                    profile.group = (profile.group as any).name ?? (profile.group as any).id ?? String(profile.group)
                }

                // ensure groups array exists
                const cfgGroups = Array.isArray((this.config.store as any).groups) ? (this.config.store as any).groups : []

                // try to find by id (loose), then by name (case-insensitive), then fallback to original string
                let found = cfgGroups.find((g: any) => g.id == profile.group)
                if (!found) {
                    const target = String(profile.group).toLowerCase()
                    found = cfgGroups.find((g: any) => String(g.name ?? '').toLowerCase() === target || String(g.id ?? '').toLowerCase() === target)
                }

                if (found) {
                    profile.group = found.name ?? String(profile.group)
                } else {
                    // if nothing found, but the group value looks like a UUID, try to find by fuzzy/case-insensitive name
                    const maybeName = String(profile.group)
                    const byName = cfgGroups.find((g: any) => String(g.name ?? '').toLowerCase() === maybeName.toLowerCase())
                    if (byName) {
                        profile.group = byName.name
                    } else {
                        profile.group = String(profile.group)
                    }
                }

                console.log('[ProfileSelector] mapped group for', profile.name, '->', profile.group, 'originalGroup:', _profile.group)
            } else {
                profile.group = 'Ungrouped'
            }

            this.profiles.push({ ...profile })
        }

        // remove built-in profiles if the setting is off
        if (!this.config.store.terminal.showBuiltinProfiles) {
            this.profiles = this.profiles.filter(x => !x.isBuiltin)
        }

        // remove template profiles
        this.profiles = this.profiles.filter(x => !x.isTemplate)

        // remove blacklisted profiles (only remove if id exists and is blacklisted)
        this.profiles = this.profiles.filter(x => !(x.id && this.config.store.profileBlacklist.includes(x.id)))

        // sort profiles by group (with special groups first) and name
        this.profiles.sort((a, b) => {
            if (a.group === b.group) {
                return a.name.localeCompare(b.name)
            }
            return this.#groupOrder(a.group!).localeCompare(this.#groupOrder(b.group!))
        })

        // diagnostic: count profiles per group
        const counts: { [k: string]: number } = {}
        for (const p of this.profiles) {
            counts[p.group!] = (counts[p.group!] || 0) + 1
        }
        console.log('[ProfileSelector] profiles loaded:', this.profiles.length, 'countsByGroup:', counts)

        // start ping checks
        this.#resetPingTimers()
        this.#loadPingPreferences()
        for (const p of this.profiles) {
            this.#schedulePing(p)
        }
    }

    selectProfile(profile: PartialProfile<Profile>, event?: MouseEvent) {
        if (event) {
            const target = event.target as HTMLElement | null
            if (target && target.closest('.status-dot')) {
                event.preventDefault()
                event.stopPropagation()
                return
            }
        }
        this.profilesService.launchProfile(profile)
        this.destroy()
    }

    async editProfile(profile: PartialProfile<Profile> | null, event?: MouseEvent) {
        if (event) {
            event.preventDefault()
            event.stopPropagation()
        }
        if (!profile) return

        try {
            const provider = this.profilesService.providerForProfile(profile)
            if (!provider) {
                console.error('[ProfileSelector] no provider for profile', profile)
                return
            }
            let pkg: any = {}
            try {
                pkg = require('tabby-settings') || {}
            } catch (e) {
                console.error('[ProfileSelector] error requiring tabby-settings', e)
                pkg = {}
            }
            const ProfilesSettingsTabComponent = this.#findProfilesSettingsTabComponent(pkg)
            const EditProfileModalComponent = pkg.EditProfileModalComponent || pkg.default?.EditProfileModalComponent || this.#findEditProfileModalComponent(pkg)
            if (!ProfilesSettingsTabComponent && !EditProfileModalComponent) {
                console.error('[ProfileSelector] EditProfileModalComponent and ProfilesSettingsTabComponent not available from tabby-settings')
                return
            }

            // find original config profile object to apply changes into
            const original = this.findConfigProfile(profile)
            const targetProfile: any = original ?? profile
            let result: any = null

            if (ProfilesSettingsTabComponent) {
                const settingsTab = new ProfilesSettingsTabComponent(
                    this.config,
                    this.injectorRef.get(HostAppService),
                    this.injectorRef.get(ProfileProvider),
                    this.profilesService,
                    this.injectorRef.get(SelectorService),
                    this.ngbModal,
                    this.injectorRef.get(PlatformService),
                    this.injectorRef.get(TranslateService),
                )
                result = await settingsTab.showProfileEditModal(targetProfile)
            } else {
                const clone = JSON.parse(JSON.stringify(targetProfile)) as any
                const modalRef = this.ngbModal.open(EditProfileModalComponent as any, { size: 'lg' })
                modalRef.componentInstance.profile = clone
                modalRef.componentInstance.profileProvider = provider
                modalRef.componentInstance.settingsComponent = provider?.settingsComponent
                result = await modalRef.result
            }
            if (result) {
                // fully replace target profile with result
                const existingId = targetProfile?.id
                for (const k in targetProfile) {
                    // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
                    delete targetProfile[k]
                }
                Object.assign(targetProfile, result)
                if (existingId && !targetProfile.id) targetProfile.id = existingId
                if (provider?.id) targetProfile.type = provider.id

                try {
                    await this.config.save()
                } catch (e) {
                    console.error('[ProfileSelector] error saving config after edit', e)
                }

                // refresh list
                this.profiles = []
                await this.#initProfiles()
                this.#doGroupProfiles(this.profiles)
            }
        } catch (e) {
            // modal dismissed or error
        }
    }

    #findEditProfileModalComponent(pkg: any): any {
        const candidates: any[] = []
        if (pkg && typeof pkg === 'object') {
            candidates.push(...Object.values(pkg))
        }

        if (pkg?.default) {
            candidates.push(pkg.default)
            if (typeof pkg.default === 'object') {
                candidates.push(...Object.values(pkg.default))
            }
            const decls = (pkg.default as any)?.ɵmod?.declarations
            if (Array.isArray(decls)) {
                candidates.push(...decls)
            }
        }

        for (const c of candidates) {
            const name = (c as any)?.name ?? ''
            if (c && (c as any).ɵcmp && /edit.*profile|profile.*edit/i.test(name)) {
                return c
            }
        }

        return null
    }

    #findProfilesSettingsTabComponent(pkg: any): any {
        if (pkg?.default?.ɵmod?.declarations && Array.isArray(pkg.default.ɵmod.declarations)) {
            const decls = pkg.default.ɵmod.declarations
            return decls.find((d: any) => (d?.name ?? '') === 'ProfilesSettingsTabComponent') ?? null
        }
        return null
    }

    // find the corresponding profile object stored in config.store.profiles
    private findConfigProfile(profile: PartialProfile<Profile> | null): any {
        if (!profile) return null
        const cfg = (this.config.store && Array.isArray(this.config.store.profiles)) ? this.config.store.profiles : []
        // try by id
        if ((profile as any).id) {
            const found = cfg.find((p: any) => p.id === (profile as any).id)
            if (found) return found
        }

        // try matching by name + host for ssh profiles
        const name = (profile as any).name
        const host = (profile as any).options?.host ?? (profile as any).host
        for (const p of cfg) {
            if (p.name === name) {
                // if both have host, match host too
                const phost = p.options?.host ?? p.host
                if (host && phost && host === phost) return p
                if (!host && !phost) return p
            }
        }

        // fallback: try deep-equal by JSON
        try {
            const target = JSON.stringify(profile)
            const found = cfg.find((p: any) => JSON.stringify(p) === target)
            if (found) return found
        } catch (e) {
            // ignore
        }

        return null
    }

    openContextMenu(profile: PartialProfile<Profile>, event: MouseEvent) {
        event.preventDefault()
        event.stopPropagation()
        this.contextMenuProfile = profile
        this.contextMenuX = event.clientX
        this.contextMenuY = event.clientY
        this.contextMenuVisible = true
    }

    @HostListener('document:click', ['$event'])
    onDocumentClick(event: MouseEvent) {
        if (!this.contextMenuVisible) return
        const target = event.target as HTMLElement | null
        if (target && target.closest('.context-menu')) return
        this.closeContextMenu()
    }

    closeContextMenu() {
        this.contextMenuVisible = false
        this.contextMenuProfile = null
    }

    async triggerEdit() {
        if (!this.contextMenuProfile) return
        const profile = this.contextMenuProfile
        this.closeContextMenu()
        await this.editProfile(profile)
    }

    async triggerDuplicate() {
        if (!this.contextMenuProfile) return
        const profile = this.contextMenuProfile
        this.closeContextMenu()
        try {
            // prefer duplicating the original config entry if available
            const original = this.findConfigProfile(profile) ?? profile
            const copy = JSON.parse(JSON.stringify(original)) as any
            delete copy.id
            copy.name = (copy.name ?? 'Profile') + ' copy'
            // append to config
            if (!Array.isArray(this.config.store.profiles)) this.config.store.profiles = []
            this.config.store.profiles.push(copy)
            await this.config.save()

            // refresh
            this.profiles = []
            await this.#initProfiles()
            this.#doGroupProfiles(this.profiles)
        } catch (e) {
            console.error('[ProfileSelector] error duplicating profile', e)
        }
    }

    async triggerDelete() {
        if (!this.contextMenuProfile) return
        const profile = this.contextMenuProfile
        this.closeContextMenu()
        try {
            // basic confirmation
            if (!confirm(`Delete "${profile.name}"?`)) return

            // locate original config profile
            const original = this.findConfigProfile(profile)
            if (original) {
                // call provider delete hook if present
                this.profilesService.providerForProfile(original)?.deleteProfile(this.profilesService.getConfigProxyForProfile(original))

                // remove from config store by identity
                this.config.store.profiles = (this.config.store.profiles || []).filter((p: any) => p !== original)
            } else {
                // fallback: try remove by matching id or name/host
                const pList = this.config.store.profiles || []
                this.config.store.profiles = pList.filter((p: any) => {
                    if (profile.id && p.id === profile.id) return false
                    if (p.name === profile.name) {
                        const phost = p.options?.host ?? p.host
                        const host = (profile as any).options?.host ?? (profile as any).host
                        if (host && phost && host === phost) return false
                        if (!host && !phost) return false
                    }
                    return true
                })
            }
            await this.config.save()

            // refresh
            this.profiles = []
            await this.#initProfiles()
            this.#doGroupProfiles(this.profiles)
        } catch (e) {
            console.error('[ProfileSelector] error deleting profile', e)
        }
    }

    onSearchChange(): void {
        try {
            console.log('onSearchChange', this.search, this.profiles)
            const q = this.search.trim().toLowerCase()

            if (q.length === 0) {
                this.#doGroupProfiles(this.profiles)
                return
            }

            const matches = new FuzzySearch(
                this.profiles.filter(p => p.group !== 'Recent'),
                ['name', 'group', 'description'],
                { sort: false },
            ).search(q);

            this.#doGroupProfiles(matches);
        } catch (error) {
            console.error('Error occurred during search:', error);
        }
    }

    async ngOnInit() {
        await this.#initProfiles()
        this.#doGroupProfiles(this.profiles)
    }

    #profileKey(profile: PartialProfile<Profile>): string {
        const id = (profile as any).id
        if (id) return String(id)
        const name = (profile as any).name ?? 'unknown'
        const host = (profile as any).options?.host ?? (profile as any).host ?? ''
        const type = (profile as any).type ?? 'profile'
        return `${type}:${name}:${host}`
    }

    #extractHost(profile: PartialProfile<Profile>): string | null {
        const host = (profile as any).options?.host ?? (profile as any).host
        return host ? String(host) : null
    }

    getStatusClass(profile: PartialProfile<Profile>): string {
        const key = this.#profileKey(profile)
        const disabled = this.pingEnabled[key] === false
        const status = disabled ? 'unknown' : (this.pingStatus[key] ?? 'unknown')
        return `status-${status} ${disabled ? 'status-disabled' : ''}`
    }

    getPingLabel(profile: PartialProfile<Profile>): string {
        const key = this.#profileKey(profile)
        if (this.pingEnabled[key] === false) return ''
        if (this.pingStatus[key] === 'testing') return '...'
        const latency = this.pingLatencyMs[key]
        if (latency == null) return '—'
        return `${latency} ms`
    }

    togglePing(profile: PartialProfile<Profile>, event?: MouseEvent) {
        if (event) {
            event.preventDefault()
            event.stopPropagation()
        }
        const key = this.#profileKey(profile)
        const isEnabled = this.pingEnabled[key] !== false
        this.pingEnabled[key] = !isEnabled

        this.#persistPingPreference(profile, this.pingEnabled[key])

        if (this.pingEnabled[key]) {
            this.#schedulePing(profile)
        } else {
            this.pingStatus[key] = 'unknown'
            this.pingLatencyMs[key] = null
            if (this.pingTimers[key]) {
                clearInterval(this.pingTimers[key])
                delete this.pingTimers[key]
            }
        }
    }

    #resetPingTimers() {
        for (const key of Object.keys(this.pingTimers)) {
            clearInterval(this.pingTimers[key])
        }
        this.pingTimers = {}
        this.pingStatus = {}
        this.pingEnabled = {}
        this.pingLatencyMs = {}
    }

    #loadPingPreferences() {
        const store = (this.config.store as any)
        const prefs = store.profileSelectorPingEnabled
        if (prefs && typeof prefs === 'object') {
            this.pingEnabled = { ...prefs }
            return
        }

        // fallback to localStorage if config has no prefs yet
        try {
            const raw = window?.localStorage?.getItem('profileSelectorPingEnabled')
            if (raw) {
                const parsed = JSON.parse(raw)
                if (parsed && typeof parsed === 'object') {
                    this.pingEnabled = { ...parsed }
                }
            }
        } catch (e) {
            console.error('[ProfileSelector] error loading ping preferences from localStorage', e)
        }
    }

    #persistPingPreference(profile: PartialProfile<Profile>, enabled: boolean) {
        const key = this.#profileKey(profile)
        const store = (this.config.store as any)
        if (!store.profileSelectorPingEnabled || typeof store.profileSelectorPingEnabled !== 'object') {
            store.profileSelectorPingEnabled = {}
        }
        store.profileSelectorPingEnabled[key] = enabled
        this.config.save().catch((e) => console.error('[ProfileSelector] error saving ping preference', e))

        try {
            window?.localStorage?.setItem('profileSelectorPingEnabled', JSON.stringify(store.profileSelectorPingEnabled))
        } catch (e) {
            console.error('[ProfileSelector] error saving ping preferences to localStorage', e)
        }
    }

    #schedulePing(profile: PartialProfile<Profile>) {
        const host = this.#extractHost(profile)
        const key = this.#profileKey(profile)
        if (!host) {
            this.pingStatus[key] = 'unknown'
            return
        }

        if (this.pingEnabled[key] === false) {
            return
        }

        const run = async () => {
            if (this.pingEnabled[key] === false) return
            this.pingStatus[key] = 'testing'
            this.pingLatencyMs[key] = null
            const result = await this.#pingHost(host)
            this.pingStatus[key] = result.ok ? 'up' : 'down'
            this.pingLatencyMs[key] = result.ok ? result.timeMs : null
        }

        void run()
        if (!this.pingTimers[key]) {
            this.pingTimers[key] = setInterval(run, this.pingIntervalMs)
        }
    }

    #pingHost(host: string): Promise<{ ok: boolean, timeMs: number | null }> {
        return new Promise((resolve) => {
            const isWin = typeof process !== 'undefined' && process.platform === 'win32'
            const timeoutMs = Math.max(1000, this.pingTimeoutMs)
            const timeoutSec = Math.ceil(timeoutMs / 1000)
            const cmd = isWin
                ? `ping -n 1 -w ${timeoutMs} ${host}`
                : `ping -c 1 -W ${timeoutSec} ${host}`

            exec(cmd, { windowsHide: true }, (error, stdout) => {
                const out = String(stdout ?? '')
                const match = out.match(/(?:time|temps)\s*[=<:]*\s*(?:<\s*)?(\d+(?:[.,]\d+)?)\s*ms/i)
                const timeMs = match ? Math.round(parseFloat(match[1].replace(',', '.'))) : null
                resolve({ ok: !error, timeMs })
            })
        })
    }
}