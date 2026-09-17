// English (US) is the source locale. New keys land here first, then propagate
// to other locales. Keep keys grouped by feature area, not by component.
// UI word for a placed item is `clip` — never `layer`, which stays the model word in
// code, commands and ADRs (CONTEXT.md **Layer**). zh-CN mirrors this as 片段.
const enUS = {
  text_correction: {
    title: "Text correction", script: "Reference text", placeholder: "Paste your reference text here…",
    saved_with_project: "Saved with your project. Applying correction splits or joins captions at manuscript line breaks and sentence endings, estimating cuts when word timing is unavailable.",
    scope: "Apply to", selected: "Selected captions ({{count}})", all: "All captions in this composition ({{count}})",
    apply_selected: "Correct {{count}} selected captions", apply_all: "Correct all {{count}} captions",
    clear: "Clear text", close: "Close", running: "Correcting…", locked: "Unlock the target captions to correct their text.",
    completed: "Text correction completed ({{count}} captions changed)",
  },
  models: {
    current_label: "Current model", none_selected: "None", none_active: "No model selected",
    switch_hint: "Select a model to switch automatically. Downloads and first-time setup require an extra step.",
    switching: "Switching to {{name}}…", switch_failed: "Could not switch to {{name}}.", still_using: "Still using {{name}}.",
    needs_download: "Download required…", needs_configuration: "Setup required…", setup_model: "Set up {{name}}",
    custom: "Custom", add_model: "Add custom model…", manage: "Model library…", edit_model: "Model settings…",
    custom_type_hint: "Choose the adapter that matches your model or service.",
    add_use: "Add and use", save_use: "Save and use", configure_use: "Configure and use", done: "Done",
    files_missing: "Local files are missing. Check the model settings.",
    model: "Model", local: "Local", online: "Online", online_model: "Online model",
    current: "In use", current_model: "In use: {{name}}", ready: "Ready", not_verified: "Not verified", not_downloaded: "Not downloaded",
    downloading: "Preparing downloads…", verifying: "Checking model…", error: "Preparation failed",
    needs_components: "A Windows runtime component is required", installing_components: "Installing runtime components…",
    install_components: "Install runtime components", download_size: "Download: {{size}}", unsupported: "Automatic downloads are unavailable on this platform. Add a custom model with compatible local files.",
    cpu_state: "Verified on CPU · Processing may be slower", online_notice: "Saving or using sends a small test request that may incur a charge. Processing sends media to this service.",
    download_use: "Download and use", verify_use: "Verify and use", use: "Use", configure: "Configure model", retry: "Retry", cancel: "Cancel",
    advanced: "Advanced settings", customized: "Customized", name: "Custom model name", runtime: "Runtime adapter",
    device_auto: "Automatic (blank); cpu or a device identifier", restore: "Restore automatic configuration", add_custom: "Save as custom model",
    custom_identity: "Changing a built-in model’s files or endpoint creates a named custom model. The built-in configuration is kept.",
    remove: "Remove custom entry", confirm_remove: "Confirm removal",
    empty_hint: "Choose a model from the list when you need it. Models are downloaded only after you confirm.",
    edit: "Edit",
    library_hint: "View saved models, edit configurations and free up downloaded storage. Browsing does not change the current model.",
    editor_hint: "Configuration is checked before saving. Closing this window keeps any preparation running.",
    save: "Save settings",
    add_only: "Add without selecting",
    download_save: "Download and save",
    details: "View progress",
    back_library: "Back to model library",
    clear_downloads: "Clear downloads",
    clear_hint: "Remove this model’s app-managed downloads. Shared files needed by other models and files you selected yourself are kept.",
    remove_hint: "Remove this custom configuration and its saved API key. Local files are kept.",
    active_remove_hint: "This model is currently selected. After removal, the selection will be None.",
    analysis_options: "Video analysis options",
    openai_speech_hint: "OpenAI Whisper uses the official OpenAI service and the fixed whisper-1 model. Only an API key is required; custom server addresses are not supported.",
    vision_local_hint: "Use a compatible llama-mtmd executable, model GGUF and matching mmproj projector. Both model files are required.",
    funasr_hint: "Use a sherpa-onnx executable, compatible ONNX model and its tokens file.",
    whisper_hint: "Use a whisper.cpp executable and compatible Whisper model file.",
    key_optional: "Optional for services without authentication",
  },
  motion_path: {
    // `mode_xy` / `mode_path` are the position mode switcher's segments, and
    // `mode_xy` doubles as the caption on the X|Y value row it governs.
    mode_xy:'XY', mode_path:'Path',
    path:'Path', nodes:'{{count}} points', node_of:'Point {{index}} / {{count}}',
    node_mode:'Spatial node', select_node:'Select a point on the path to edit it', mode_corner:'Corner', mode_smooth:'Smooth', mode_auto:'Auto smooth', insert:'Insert after point',
    insert_hint:'Double-click the path to insert without changing its shape. Adjacent Auto nodes become Smooth to preserve their handles.',
    start_frame:'Start frame (local)', end_frame:'End frame (inclusive)', every_frames:'Maximum frame interval', samples_used:'keys per property', range_error:'The range must stay within this clip.',
    tolerance:'Target error (pixels)', nodes_used:'{{count}} path nodes',
    jump_error:'This range contains an instantaneous position jump. Convert separate ranges or keep the current mode.',
    conversion_range_error:'Choose a valid range of at most 16384 frames with microsecond-compatible frame rate.',
    conversion_options_error:'Use a target of at least 0.05 pixels and a positive integer frame interval.',
    conversion_capacity_error:'Conversion exceeds 4096 keys per property or the check budget. Shorten the range or increase the interval.',
    node_limit:'The 128-node budget cannot meet the target. Preview only: shorten the range or relax the target.',
    key_limit:'The keyframe budget cannot meet the target. Preview only: shorten the range or relax the target.',
    frame_grid:'The current frame grid cannot meet the target. Preview only: relax the target or keep the current mode.',
    create:'Create motion path', edit:'Edit path', show:'Show trajectory', done:'Done',
    add:'Add point', curve:'Line / curve', remove:'Remove point',
    anchor:'The marked anchor follows the path. Select a point to edit its handles.',
    corner:'The marked position reference (unrotated top-left) follows the path.',
    to_path:'Convert XY to path…', to_xy:'Bake to XY…', preview:'Preview conversion', apply:'Apply conversion', cancel:'Cancel',
    error:'Measured position error: {{error}} px ({{count}} checks)',
    conversion_note:'Only the chosen range is retained; outside it the result holds. XY is fitted to editable curves; temporal keys are added to meet the error target. Error is checked at frames, quarter-frames and key boundaries, not guaranteed continuously. Instantaneous position jumps are refused.',
  },
  app: {
    title: "WeftCut",
    core_status: "core: {{status}}",
    window_title: "WeftCut — {{name}}",
  },
  splash: {
    starting: "Starting system checks…",
    checking: "Checking: {{items}}",
    check_separator: " · ",
    resolving_project: "Checking the launch project…",
    ready: "Ready",
    check: {
      evaluation_runtime: "evaluation engine",
      motif_capture_runtime: "Motif capture runtime",
      motif_catalog: "Motif catalog",
      motif_catalog_listener: "Motif change listener",
    },
  },
  keyframe: {
    stopwatch_enable: "Animate this property (add a keyframe at the playhead)",
    stopwatch_disable: "Stop animating — removes all keyframes (keeps the value at the playhead; undoable)",
    stopwatch_offscreen: "Move the playhead over the clip to keyframe",
    // The stopwatch's accessible name. A merged axis row puts two of them
    // side by side with no caption, so the name has to carry the param.
    stopwatch_param: "{{param}} — {{action}}",
    nav_prev: "Previous keyframe",
    nav_set: "Add or remove a keyframe at the playhead",
    nav_next: "Next keyframe",
    interp_hold: "Hold",
    interp_linear: "Linear",
    interp_ease_in: "Ease In",
    interp_ease_out: "Ease Out",
    interp_ease: "Ease",
    interp_ease_in_out: "Ease In-Out",
    // Preset gallery labels — one per canonical-table id (keyframe.interp_<id>,
    // see src/shared/easing.ts), family style matching "Ease In/Out/In-Out".
    interp_ease_in_sine: "Sine In",
    interp_ease_out_sine: "Sine Out",
    interp_ease_in_out_sine: "Sine In-Out",
    interp_ease_in_quad: "Quad In",
    interp_ease_out_quad: "Quad Out",
    interp_ease_in_out_quad: "Quad In-Out",
    interp_ease_in_cubic: "Cubic In",
    interp_ease_out_cubic: "Cubic Out",
    interp_ease_in_out_cubic: "Cubic In-Out",
    interp_ease_in_quart: "Quart In",
    interp_ease_out_quart: "Quart Out",
    interp_ease_in_out_quart: "Quart In-Out",
    interp_ease_in_quint: "Quint In",
    interp_ease_out_quint: "Quint Out",
    interp_ease_in_out_quint: "Quint In-Out",
    interp_ease_in_expo: "Expo In",
    interp_ease_out_expo: "Expo Out",
    interp_ease_in_out_expo: "Expo In-Out",
    interp_ease_in_circ: "Circ In",
    interp_ease_out_circ: "Circ Out",
    interp_ease_in_out_circ: "Circ In-Out",
    interp_ease_in_back: "Back In",
    interp_ease_out_back: "Back Out",
    interp_ease_in_out_back: "Back In-Out",
    interp_ease_in_elastic: "Elastic In",
    interp_ease_out_elastic: "Elastic Out",
    interp_ease_in_out_elastic: "Elastic In-Out",
    interp_ease_in_bounce: "Bounce In",
    interp_ease_out_bounce: "Bounce Out",
    interp_ease_in_out_bounce: "Bounce In-Out",
    elastic_amplitude: "Amplitude",
    elastic_period: "Period",
    procedural_badge: "Procedural",
    smooth: "Smooth",
    easing_library: "Easing library…",
    // Tangent-handle context menu: the key's continuity.
    continuity_smooth: "Smooth",
    continuity_broken: "Broken",
    // Extrapolation submenus on a track's first / last key; the five modes
    // (keyframe.extrapolate_<id>, see renderer/keyframe/curve.ts).
    extrapolate_before: "Extrapolate before",
    extrapolate_after: "Extrapolate after",
    extrapolate_hold: "Hold",
    extrapolate_loop: "Loop",
    extrapolate_ping_pong: "Ping-pong",
    extrapolate_offset: "Offset",
    extrapolate_continue: "Continue",
    // Gallery row labels — one per canonical-table family (keyframe.family_<x>,
    // derived from the preset id's last segment; "classic" heads the table).
    family_classic: "Basic",
    family_sine: "Sine",
    family_quad: "Quad",
    family_cubic: "Cubic",
    family_quart: "Quart",
    family_quint: "Quint",
    family_expo: "Expo",
    family_circ: "Circ",
    family_back: "Back",
    family_elastic: "Elastic",
    family_bounce: "Bounce",
  },
  startup: {
    subtitle: "Pick a project to open, or create a new one.",
    new_project: "New project",
    open_project: "Open project…",
    open_dialog_title: "Open WeftCut project folder",
    recent_heading: "Recent",
    recent_loading: "Loading…",
    recent_empty: "No recent projects yet.",
    recent_remove_hint: "Remove from list",
    recent_show_all: "Show all ({{count}})",
    recent_show_less: "Show less",
    recent_open_failed: "Couldn't open project: {{detail}}",
    recents_load_failed: "Couldn't load the recent projects list: {{detail}}",
    not_project_folder:
      "That folder isn't a WeftCut project. Pick a folder created by WeftCut, or start a new project.",
    project_folder_missing:
      "That project folder no longer exists — it may have been moved, renamed, or deleted. It was removed from the recent list.",
    // States the mismatch and stops. "Update WeftCut" is a guess that happens to
    // be wrong for the file this fires on most often — a project left behind by
    // a different build of this same repo.
    project_schema_too_new:
      "That project was written by a different build of WeftCut (project format v{{found}}); this build reads v{{supported}}.",
    project_schema_unreadable:
      "That folder's project.json declares no project format version this build recognizes, so it can't be opened.",
    project_file_unreadable:
      "That project's project.json couldn't be read: {{detail}}",
    project_invalid:
      "That project's contents didn't pass validation — the file may be damaged or hand-edited.",
    time_just_now: "just now",
    time_minutes_ago_one: "{{count}} minute ago",
    time_minutes_ago_other: "{{count}} minutes ago",
    time_hours_ago_one: "{{count}} hour ago",
    time_hours_ago_other: "{{count}} hours ago",
    time_days_ago_one: "{{count}} day ago",
    time_days_ago_other: "{{count}} days ago",
  },
  // Canvas vocabulary shared by the New Project dialog and Settings > Canvas.
  // Both surfaces author the same two values off the same lists
  // (`startup/canvasPresets.ts`), so the wording lives in one place too.
  canvas: {
    // Parenthetical after a rate — what a newcomer needs in order to pick 25
    // over 30, at the one moment the choice is still freely reversible.
    fps_note: {
      film: "film",
      pal: "PAL",
      ntsc: "NTSC",
      ntsc_film: "NTSC film",
    },
    size_range: "Width and height must be between {{min}} and {{max}}.",
    size_odd: "Width and height must be whole even numbers.",
    size_too_many_pixels: "Total canvas area cannot exceed 8K (7680 × 4320).",
  },
  new_project: {
    title: "New project",
    name: "Project name",
    name_placeholder: "e.g. My documentary",
    parent_folder: "Save in",
    parent_folder_placeholder: "Pick a parent folder…",
    choose_folder: "Choose…",
    pick_parent_title: "Pick a parent folder for the new project",
    validation_empty: "Project name is required.",
    validation_whitespace: "Project name can't start or end with whitespace.",
    validation_invalid_chars:
      "Project name can't contain any of: \\ / : * ? \" < > |",
    validation_trailing_dot: "Project name can't end with a period.",
    validation_reserved: "Project name is reserved by the OS — pick another.",
    resolution: "Resolution",
    resolution_custom: "Custom",
    custom_size: "Custom size",
    width: "Width",
    height: "Height",
    frame_rate: "Frame rate",
    create: "Create",
    creating: "Creating…",
    cancel: "Cancel",
    folder_exists:
      "A folder with that name is already there. Pick a different name, or a different location.",
    invalid_preset: "That canvas size or frame rate isn't valid — pick another.",
    create_failed: "Couldn't create the project: {{detail}}",
  },
  project: {
    canvas: "{{width}}×{{height}} · {{fps}}",
    fps_simple: "{{fps}}fps",
    fps_rational: "{{fps}}fps",
    tracks_one: "{{count}} track",
    tracks_other: "{{count}} tracks",
    duration: "{{value}}",
    derivatives_pending_one: "Generating {{count}} derivative…",
    derivatives_pending_other: "Generating {{count}} derivatives…",
    derivatives_pending: "Generating {{count}} derivatives…",
    derivatives_pending_hint:
      "Background proxy / thumbnail / waveform jobs for imported media. Editor stays fully usable while they run.",
  },
  menu: {
    file: "File",
    edit: "Edit",
    insert: "Insert",
    view: "View",
    help: "Help",
  },
  dev: {
    menu: "Dev",
    performance_monitor: "Performance Monitor",
  },
  updates: {
    disabled: 'Automatic updates are unavailable in this build. Download releases from the project page.',
    idle: 'Ready to check for updates.',
    checking: 'Checking for updates…',
    current: 'You are up to date.',
    downloading: 'Downloading {{version}}… {{percent}}%',
    ready: '{{version}} is ready. It will install when you exit WeftCut normally. Finish your exports before closing.',
    error: 'Could not check for or download the update. Try again, or download it from the releases page.',
    releases: 'View Releases',
  },
  help: {
    check_updates: "Check for Updates…",
    report_issue: "Report an Issue…",
    about: "About WeftCut",
    version: "Version {{version}}",
    developed_by: "Developed by UncleChair",
    license_mit: "License: WeftCut is <mit>MIT</mit>-licensed.",
    third_party:
      "Third-party components have their own licenses: <notices>THIRD-PARTY-NOTICES.md</notices>.",
    copy_version: "Copy Version Info",
    copied: "Copied",
    project_link: "Project Page",
  },
  view: {
    display_mode_heading: "Track display",
    panels_heading: "Panels",
    display_ab_roll: "A/B Roll",
    display_all_tracks: "All Tracks",
    follow_playhead: "Timeline auto-scroll",
    show_markers: "Show markers",
    show_safe_areas: "Show safe areas",
    close_active_panel: "Close Active Panel",
    reset_workspace: "Reset Workspace",
    workspaces_heading: "Workspaces",
    workspace_editing: "Default Layout",
    save_workspace: "Save Workspace",
    save_workspace_as: "Save as New Workspace…",
    rename_workspace: "Rename Workspace…",
    delete_workspace: "Delete Workspace",
    enter_agent_mode: "Enter Agent Mode",
  },
  quick_actions: {
    hand_tool_hint:
      "Hand tool: drag to pan the enlarged preview. The middle mouse button pans under any tool, and the wheel or a trackpad pinch zooms. Escape returns to Selection.",
    tools: "Tools",
    toggles: "Toggles",
    edit: "Edit",
    range: "In/Out",
    markers: "Markers",
    resolution: "Playback resolution",
    // The cycling button's three tooltips: current rung, then the rung a click
    // moves to. Both halves are load-bearing here in a way they are not for the
    // two-state toggles below — that button's glyph and pressed border already
    // say which of two states it is in, whereas three rungs mean the successor
    // is genuinely unguessable without being told.
    resolution_full_hint: "Playback resolution: Full. Click for 1/2.",
    resolution_half_hint: "Playback resolution: 1/2. Click for 1/4.",
    resolution_quarter_hint: "Playback resolution: 1/4. Click for Full.",
    // Shown on the disabled Clear button — says why it's disabled rather than
    // repeating the label the user can't act on.
    clear_range_empty: "No in/out points marked",
    // The Text tool's two tooltips. Armed or armable, the hint teaches the
    // gesture the icon alone cannot; disabled (an empty project has no canvas
    // to click), it names the remedy — `clear_range_empty`'s rule.
    text_tool_hint: "Text tool: click the preview to add text, click text to edit it",
    text_tool_needs_layer: "Add a clip first, or insert text from the Insert menu",
    // The marker toggle's two-state hint: current state, then what a click does.
    // Both halves matter — the pressed border says WHICH state, not what
    // pressing again would get you.
    markers_shown_hint: "Showing timeline markers. Click to hide.",
    markers_hidden_hint: "Timeline markers hidden. Click to show.",
    // Same two-state shape for the three toggles that joined the section: the
    // pressed border says which state, the hint says what a click does.
    snap_on_hint: "Clip snapping on. Click to disable.",
    snap_off_hint: "Clip snapping off. Click to enable.",
    follow_on_hint: "Timeline auto-scroll on. Click to disable.",
    follow_off_hint: "Timeline auto-scroll off. Click to enable.",
    safe_area_on_hint: "Showing safe-area guides. Click to hide.",
    safe_area_off_hint: "Safe-area guides hidden. Click to show.",
    link_override_on_hint: "Links off — edits act on single clips. Click to restore links.",
    link_override_off_hint: "Links on. Click to edit single clips without holding Alt.",
    // Disabled-button reasons, the `clear_range_empty` rule: name the
    // precondition rather than restate a label that can't be acted on.
    link_selected: "Link selected clips",
    unlink_selected: "Unlink selected clips",
    link_needs_two: "Select two or more unlinked clips to link them",
    link_mixed_selection: "Select clips that are all unlinked, or all in one link",
    // Group / Ungroup, same rule: a greyed button names the precondition. The
    // three not-plain reasons are separate strings because each names a
    // different field to reset (`timeline/groupEligibility.ts`).
    group_selected: "Group selected clips",
    group_needs_selection: "Select one or more clips to group them",
    group_locked: "Unlock the selected clips to group them",
    ungroup_selected: "Ungroup — put the group's clips back",
    ungroup_needs_one_group: "Select exactly one group clip to ungroup it",
    ungroup_locked: "Unlock the group clip to ungroup it",
    ungroup_not_plain_transform:
      "Reset the group's transform first — ungrouping cannot carry it onto the clips inside",
    ungroup_not_plain_opacity:
      "Reset the group's opacity to 1 first — ungrouping cannot carry it onto the clips inside",
    ungroup_not_plain_effects:
      "Remove the group's effects first — ungrouping cannot carry them onto the clips inside",
    // Ripple delete. Only TWO reasons live here: the rest of them are refusals
    // the planner returns, and their sentences are the curated refusal copy
    // under `errors.ripple_*` — the same line the status bar shows when the
    // actor refuses for real, so there is no second wording to keep in step
    // (`timeline/rippleEligibility.ts`).
    ripple_needs_selection:
      "Select the clips to remove and close the gap after, or click a gap to close it",
    // Not a refusal but the precedence rule showing through: the key is about to
    // do the keyframe delete, so the row says so rather than pretending the
    // ripple is merely unavailable.
    ripple_keyframes:
      "Keyframes are selected — this key deletes them. Deselect them to ripple the clips instead",
    // Add to Group. Only the clip's context menu shows these, but they are the
    // same kind of sentence as the two above and drift if kept apart. Its shape
    // failures stay separate rather than collapsing the way Ungroup's do: the
    // destination and the members are two different things to go and select.
    add_to_group_needs_selection:
      "Select the clips to add, and the group clip to add them to",
    add_to_group_needs_one_group: "Select exactly one group clip to add to",
    add_to_group_needs_member:
      "Select the clips to add as well as the group clip",
    add_to_group_locked: "Unlock the clips you are adding to the group",
    add_to_group_starts_before_group:
      "This clip starts before the group does — move it later first",
    // Move to…. The first three explain the greyed submenu TRIGGER — what to
    // go and fix about the selection — and the rest explain one greyed
    // destination row, where the answer is to pick a different one. A
    // destination row names itself, so none of these names one (CONTEXT.md's
    // Composition entry says why the word stays out of UI copy).
    move_to_composition_needs_selection: "Select the clips to move",
    move_to_composition_locked: "Unlock the clips you are moving",
    move_to_composition_no_destination:
      "There is nowhere else these clips can go",
    move_to_composition_already_there: "These clips are already here",
    move_to_composition_cycle:
      "A selected group already contains it — the group cannot also sit inside it",
    move_to_composition_offscreen:
      "Not on screen at the playhead — the clips land at its start",
    // Transcribe. The clip menu is the only surface that shows these, but
    // they are the same kind of sentence as the ones above and drift if kept
    // apart. Each names one thing to go and do — which is why the wrong-kind
    // and speed cases stay separate: "pick a clip with sound" and "split a
    // speed-1 segment off" are different work.
    auto_caption_needs_selection: "Select a video or audio clip to transcribe",
    auto_caption_needs_audio_kind:
      "This clip carries no sound — select a video or audio clip",
    auto_caption_speed_not_one:
      "This clip is re-timed — split a normal-speed segment off it first, or the words land in the wrong place",
    auto_caption_transcribing: "A transcription is already running",
    // Detect pauses. Mostly the transcribe gate, said in the verb the row
    // uses: the place to go is the same, but "to transcribe" and "to measure"
    // are not the same errand.
    //
    // `needs_selection` asks for an AUDIO clip where transcription asks for
    // either kind, and that is not a slip: a picture clip is measurable only
    // through the audio it is linked to, so naming the audio is the shortest
    // route to a selection that works.
    detect_pauses_needs_selection: "Select an audio clip to measure",
    detect_pauses_needs_audio_kind:
      "This clip carries no sound — select a video or audio clip",
    detect_pauses_speed_not_one:
      "This clip is re-timed — split a normal-speed segment off it first, or the pauses land in the wrong place",
    // The one reason that belongs to pauses alone: the clip's own file may
    // carry a track, but what plays is the linked Audio layer, and this clip
    // has none (spec Decision 1).
    detect_pauses_plays_no_sound: "This clip plays no sound",
    // Describe content. Its own three sentences again, and the kind case is the
    // one that genuinely differs from the two blocks above: a description reads
    // frames, so sound is not what makes a clip eligible here.
    describe_needs_selection: "Select a video clip to describe",
    describe_needs_video_kind:
      "A description reads frames — select a video clip",
    describe_speed_not_one:
      "This clip is re-timed — split a normal-speed segment off it first, or the descriptions land in the wrong place",
    describe_already_running:
      "A description is already running — wait for it to finish",
  },
  dock_workspace: {
    editing_label: "Editing workspace",
    empty_label: "Empty workspace",
    all_closed: "All panels are closed.",
    open_panel: "Open Panel",
    reset: "Reset Workspace",
    close_panel: "Close Panel",
    move_panel: "Drag to move {{title}}",
    scroll_tabs: {
      start: "Show earlier Panel tabs",
      end: "Show later Panel tabs",
    },
    // A timeline Panel's own tab: it names the composition it shows, and its
    // tooltip prints the route the Panel was opened along.
    timeline_tab: {
      // The first step of that route. The root composition is never named in
      // the UI — it IS the timeline — so a path starts at the project, and this
      // stands in for a project saved under no name yet.
      project: "Project",
      // Offered only where a Group is placed more than once: two placements are
      // two different answers to "where on the film's clock does this sit", and
      // the tab has to say which one it reads its times against.
      switch_anchor: "Switch anchor",
      anchor_entry: "{{path}} · {{time}}",
    },
    panels: {
      media: "Media Pool",
      transitions: "Transitions",
      preview: "Preview",
      timeline: "Timeline",
      "quick-actions": "Quick Actions",
      attribute: "Attribute",
      caption: "Caption",
      marker: "Markers",
      "role-mixer": "Role Mixer",
      effect: "Effect",
      playhead: "Playhead",
      agent: "Agent",
      history: "History",
      // Plural, because the Panel is a list of them and the tab names what it
      // holds. Never "Scene detection" — the detector's name is not what a
      // reviewer is looking at.
      shots: "Shots",
    },
    position: {
      left: "left",
      right: "right",
      top: "top",
      bottom: "bottom",
      center: "center",
    },
    announce: {
      opened: "{{title}} opened",
      closed: "{{title}} closed",
      maximized: "{{title}} maximized",
      restored: "{{title}} restored",
      pick_target:
        "Moving {{source}}. Target {{target}}, {{current}} of {{total}}. Press Enter to choose it.",
      pick_edge:
        "Dock at the {{position}} of {{target}}. Use the arrow keys to change position, then press Enter.",
      committed: "Moved {{source}} to the {{position}} of {{target}}.",
      cancelled: "Panel move cancelled.",
      not_allowed: "That panel move is not allowed.",
    },
  },
  workspace_name: {
    save_as_title: "Save as New Workspace",
    rename_title: "Rename Workspace",
    name_label: "Workspace name",
    placeholder: "e.g. Color Grading",
    confirm: "Save",
    cancel: "Cancel",
  },
  marker_rename: {
    title: "Rename Marker",
    label: "Marker label",
    placeholder: "e.g. Trim this pause",
    confirm: "Rename",
    cancel: "Cancel",
  },
  marker_panel: {
    // A section heading, and the whole disclosure control: the composition's
    // name plus how many markers it holds. A composition with none still gets
    // one — "nothing is marked here" is an answer, and a missing heading is not.
    section_heading: "{{name}} ({{count}})",
    // The section for markers whose clip no longer shows the frame they name.
    // CONTEXT.md's pinned word.
    hibernating: "Hibernating",
    // Row fields. There is deliberately no time field: a marker's time is
    // spatial and belongs to the lane's drag (ADR 0056) — on an anchored marker
    // the next reconcile would overwrite anything typed here.
    label_field: "Marker label",
    note_field: "Marker note",
    color_field: "Marker color",
    // A marker that follows a clip, as against a free one. CONTEXT.md's pinned
    // word — never "clip marker", which would name a second entity.
    anchored: "Anchored",
    go_to: "Go to {{timecode}}",
    // A hibernating row seeks nowhere: the frame it names is on no timeline
    // right now, so the only honest destination is the clip it is tied to.
    reveal_clip: "In the footage at {{timecode}} — reveal the anchoring clip",
    // The one exit from hibernation. CONTEXT.md's pinned word.
    detach: "Detach",
    // The row's delete. Same words as the lane's context menu row
    // (`timeline.delete_marker`) and deliberately its own key: the Panel names
    // its own affordances, as `detach` above already does.
    delete: "Delete marker",
  },
  shots_panel: {
    // State (a): no subject. It names the kind rather than saying "nothing
    // selected", because an Audio or Text clip IS selected and still has no
    // shots to review.
    needs_video_clip: "Select a video clip to review its shot cuts.",
    // Between the two states, while the probe stats the sidecar. A distinct
    // sentence, because "not analyzed" would be a claim the probe has not made
    // yet — and it flickers past in a frame on a hit.
    checking: "Checking for a shot analysis…",
    not_analyzed: "“{{clip}}” has not been analyzed for shot cuts yet.",
    // No percentage exists to report: the ffmpeg pass emits metadata lines, not
    // progress. A running label and a disabled button are the whole affordance.
    analyzing: "Analyzing “{{clip}}” — this decodes the whole source once.",
    analyze: "Analyze",
    analyze_running: "Analyzing…",
    // A scanned source whose window holds no boundary above the threshold. An
    // answer, not a failure.
    no_shots: "No shot cuts in this clip's range.",
    // The strip's axis, named by what it MEASURES. The wire field is called
    // `sensitivity` and reaches no label: a higher value yields FEWER cuts, so
    // the word reads backwards — the control's meaning is the line's position.
    axis_frame_change: "Frame change",
    threshold_line: "Shot cut threshold",
    threshold_value: "{{value}} frame change",
    // The floor scan emitted nothing inside this clip's range, so there is no
    // signal for a line to cross.
    no_candidates:
      "No candidate cuts in this clip's range — nothing for a threshold to sort.",
    // Output granularity, not accuracy: boundaries closer together than this
    // are dropped. In milliseconds because the source's own frame rate is not
    // known here.
    min_shot_length: "Minimum shot length",
    milliseconds: "ms",
    go_to: "Go to {{timecode}}",
    cover_frame: "Cover frame of shot {{index}}",
    // The pair either side of a candidate boundary — the one look that answers
    // "is this a real cut".
    frame_before: "Frame before the cut",
    frame_after: "Frame at the cut",
    score: "Detector confidence at this boundary",
    // Checked = this boundary stands. Clearing it merges the shot into the one
    // before it; the cleared boundary stays on that row so it can be restored.
    accept_candidate: "Cut at the start of shot {{index}}",
    restore_candidate: "Restore the cut at {{timecode}}",
    // The toggle's hover text says the ACTION, as the seam glyph does — the
    // label above names the option, which is not the same thing.
    merge_candidate_hint: "Clear the cut and merge into the previous shot",
    restore_candidate_hint: "Split here",
    // Checked = keep. Every row starts kept, so a plain apply is "split here"
    // and discarding is opted into row by row.
    keep_shot: "Keep shot {{index}}",
    // Absent and not zero: a span nothing has sampled has no brightness, and
    // "0.00" would report a black frame.
    stats_absent: "not measured",
    // The on-demand stats pass. Named for the rows it acts on, because it acts
    // on all of them that have nothing — the hint says what it costs, since the
    // cost is the only reason it is not automatic.
    measure: "Measure shots",
    measure_running: "Measuring…",
    measure_hint:
      "Sample three frames per shot for brightness, motion and focus — one ffmpeg pass per shot, so it is opt-in.",
    // Disabled-button reasons, `apply_no_cuts`' rule: name the precondition
    // rather than repeat a label that cannot be acted on.
    measure_all_measured: "Every shot in this list is already measured",
    measure_busy: "An apply is already running",
    brightness: "Mean brightness",
    motion: "Motion between sampled frames",
    sharpness: "Focus proxy (variance of the Laplacian)",
    brightness_value: "B {{value}}",
    motion_value: "M {{value}}",
    sharpness_value: "S {{value}}",
    flag_black: "black",
    flag_freeze: "freeze",
    flag_fade: "fade",
    // The three verbs over the reviewed list. Named for what they do to the
    // clip, not for the wire's mode: "Split at cuts" says where, and the
    // discarding one says both halves of what it is about to do.
    apply_split: "Split at cuts",
    apply_mark: "Mark cuts",
    apply_discard: "Split and discard unchecked",
    // Disabled-button reasons, `quick_actions.clear_range_empty`'s rule: name
    // the precondition — here the remedy — rather than repeat a label that
    // cannot be acted on. There is deliberately no sentence for an
    // all-unchecked discard: the channel refuses that one and its wording is
    // the only one, so the press goes out and the refusal lands below.
    apply_no_cuts:
      "Lower the threshold, or restore a cleared cut — this clip is one shot",
    apply_no_discards: "Uncheck the shots you want discarded first",
    apply_running: "An apply is already running",
    // The description column's empty state. A shot without a description is the
    // ordinary case — the phrase says which state it is in, where a blank cell
    // would read as a load that never finished.
    not_described: "Not described",
    // The one legitimate transient, and only where the cell has nothing else to
    // show: a run whose window overlaps this row is on its way.
    describing: "Describing…",
    // The per-row press. Named for the unit it acts on, because the clip-wide
    // gesture has the same verb in the Edit menu and the two must not read as
    // the same button.
    describe_shot: "Describe shot",
    // A row that already has prose. "Again" and not "Re-describe": the row is
    // not being corrected, it is being asked a second time, which is a normal
    // thing to want from a model.
    describe_shot_again: "Describe again",
    describe_shot_hint:
      "Ask the vision model what is in this shot — one local model run, in the app's language.",
    // What the status-log rows call one shot's run. Interpolated into
    // `log.describe_started` / `log.describe_done` in place of a clip name, so
    // a sweep's rows say which shot each one was.
    describe_shot_subject: "{{clip}} · shot {{index}}",
    // The sweep. The count is in the label because the cost is linear in it —
    // hiding the N would hide the whole decision. Pluralized like
    // `project.tracks`, since it is read at 1 as often as at 30.
    describe_all_one: "Describe {{count}} shot",
    describe_all_other: "Describe {{count}} shots",
    describe_all_hint:
      "Describe every shot that has nothing yet, one after another — each is its own local model run, so it is opt-in.",
    // While it runs the button IS the stop. `done` counts finished runs, so it
    // reads 0/7 while the first one is going.
    describe_all_running: "Stop ({{done}}/{{total}})",
    describe_all_stop_hint:
      "Stop after the shot being described now — there is no way to cancel a model run already in flight, and its prose is kept.",
    // Disabled-button reasons, `measure_all_measured`'s rule: name the
    // precondition rather than repeat a label that cannot be acted on.
    describe_all_described: "Every shot in this list already has a description",
    describe_running: "A description is already running",
    describe_sweep_running: "A shot-by-shot description pass is already running",
    // The tool's own precondition, said before the press: sampling maps window
    // time onto source time with no speed factor, so a re-timed clip's segments
    // would be stamped at source times its frames never show.
    describe_speed_not_one:
      "Split off a speed-1 segment first — a re-timed clip cannot be described",
  },
  actions: {
    add_color_layer: "Color clip",
    add_text_layer: "Text",
    select_tool: "Selection tool",
    toggle_blade_mode: "Blade tool",
    select_text_tool: "Text tool",
    select_hand_tool: "Hand tool",
    preview_zoom_in: "Zoom in preview",
    preview_zoom_out: "Zoom out preview",
    preview_zoom_fit: "Fit preview to window",
    move_to_new_track: "Move to a new track",
    import_media: "Import media…",
    export: "Export…",
    save: "Save",
    save_as: "Save as…",
    save_and_close: "Save and Close",
    save_and_close_hint:
      "Flush any pending edits to the workspace, then return to the project picker.",
    undo: "Undo",
    redo: "Redo",
    settings: "Settings…",
    settings_hint: "Preferences, shortcuts & API keys.",
    motifs: "Motifs…",
    motifs_hint:
      "Pick a motif overlay (lower third, title card, callout, …) and drop it on the timeline.",
    open_agent_panel: "Open Agent Panel",
    enter_agent_mode: "Enter Agent Mode",
    create_checkpoint: "Create Checkpoint…",
    create_checkpoint_hint:
      "Name the current state so you can come back to it. This session only — checkpoints are not saved with the project.",
    // Not menu items — these labels show up in the Settings → Keyboard
    // panel for shortcuts that don't have a menu home (transport,
    // timeline edits).
    toggle_play: "Play / pause",
    // "clips" rather than "layers": the command is reached from the timeline,
    // where what the user sees selected is clips on tracks.
    select_all: "Select all clips",
    deselect_all: "Deselect all",
    delete_selected: "Delete selected clip",
    // Premiere's own English term. Kept short because it also sits on a 16 px
    // strip button's tooltip and on a context-menu row beside plain Delete,
    // where the contrast between the two labels is the whole explanation.
    ripple_delete_selected: "Ripple delete",
    copy_selected: "Copy selected clip",
    paste_at_playhead: "Paste clip at playhead",
    split_at_playhead: "Split at playhead",
    toggle_log: "Toggle activity log",
    focus_log_search: "Focus activity-log search",
    toggle_display_mode: "Toggle A/B Roll / All Tracks",
    toggle_follow_playhead: "Toggle timeline auto-scroll",
    toggle_markers_visible: "Toggle timeline markers",
    toggle_safe_area_guides: "Toggle safe-area guides",
    toggle_tail_snap: "Toggle clip snapping",
    // Prefixed, unlike the bare "Full" / "1/2" the Settings radio uses: these
    // labels also appear in the search palette, where a row reading just
    // "1/2" says nothing about what it would change.
    playback_resolution_full: "Playback resolution: Full",
    playback_resolution_half: "Playback resolution: 1/2",
    playback_resolution_quarter: "Playback resolution: 1/4",
    // The strip's one-button form. Named for what it does rather than for a
    // value, because unlike the three above it lands somewhere different every
    // time it runs — a palette row promising "1/2" that sometimes gives 1/4
    // would be worse than no row.
    playback_resolution_cycle: "Cycle playback resolution",
    center_horizontally: "Center horizontally",
    center_vertically: "Center vertically",
    apply_default_transition: "Apply default transition (crossfade)",
    zoom_timeline_in: "Zoom timeline in",
    zoom_timeline_out: "Zoom timeline out",
    focus_next_panel: "Focus next Panel",
    focus_previous_panel: "Focus previous Panel",
    toggle_maximize_panel: "Maximize / restore Panel",
    restore_maximized_panel: "Restore maximized Panel",
    group_selected: "Group selected clips",
    ungroup_selected: "Ungroup",
    open_group: "Open group",
    add_to_group: "Add to Group",
    // The context menu's version, which knows the Group it was opened over. The
    // menus built once — Edit, the native bar, the search palette — keep the
    // plain label above (`menu/CommandContextItem.tsx` says why).
    add_to_group_named: "Add to “{{name}}”",
    // Two forms, two labels. The submenu trigger is followed by the list of
    // destinations, each of which names itself, so the trigger keeps only the
    // ellipsis; the Edit menu and the palette have no list behind them and
    // that form means "move to the root", so it names the timeline outright
    // (`shortcuts/defs.ts` says what those forms do).
    move_to_composition: "Move to timeline",
    move_to_composition_submenu: "Move to…",
    // The three analysis rows name their subject — "selected clip" — because
    // they sit in the Edit menu and the palette as well as on the clip itself,
    // and there a row has to say what it will act on. The context menu keeps
    // the same label: the right-click has just made the clicked clip that
    // selection, so the sentence stays true.
    //
    // "Transcribe" and not "Auto-caption": the row asks the speech engine a
    // question about the clip, and the name says which one. What lands is
    // still a caption track — the Caption panel opens on success to show it.
    // No ellipsis: nothing is asked before it runs. The language is the
    // engine's to detect, so the one field the old dialog carried was a click
    // that asked nothing (`speech/transcribeRun.ts`).
    auto_caption_selected: "Transcribe selected clip",
    // "Detect pauses" and not "Cut pauses": nothing is removed by the row
    // itself. Measuring is the half every pause recipe shares, and what becomes
    // of the pauses is decided inside the section it opens
    // (`timeline/LayerContextMenu.tsx` carries the whole reason). Ellipsis
    // because that section comes first.
    detect_pauses_selected: "Detect pauses in selected clip…",
    // "Content" as the head noun: what the model reads is what is IN the
    // footage, and the row's answer lands as prose on the shot rows rather than
    // as anything about the clip as an object. "Clip" still names the unit the
    // press acts on — the whole clip, where the per-row `describe_shot` button
    // acts on one shot.
    //
    // No ellipsis, like the transcribe row: sampling and focus live in
    // Settings → Video understanding now, so the press runs rather than asks.
    describe_selected: "Describe selected clip content",
    open_voiceover: "Voiceover…",
    // Ellipsis because the row opens a surface rather than committing anything:
    // reviewing is what happens next, and the apply is a press inside the Panel.
    review_shots: "Review shots…",
    toggle_link_selected: "Link / Unlink selected clips",
    toggle_link_override: "Toggle link override",
    // One key, two subjects — the label names the gesture and the hint below it
    // names what each selection makes it do.
    nudge_back: "Nudge earlier",
    nudge_forward: "Nudge later",
    nudge_large_back: "Nudge earlier (large)",
    nudge_large_forward: "Nudge later (large)",
    resync_audio_to_video: "Re-sync audio to video",
    seek_frame_back: "Step back one frame",
    seek_frame_forward: "Step forward one frame",
    seek_second_back: "Step back one second",
    seek_second_forward: "Step forward one second",
    seek_prev_edit: "Go to previous edit point",
    seek_next_edit: "Go to next edit point",
    seek_start: "Go to start",
    seek_end: "Go to end",
    mark_in: "Mark in point",
    mark_out: "Mark out point",
    add_marker_at_playhead: "Add marker at playhead",
    // The named flags on the marker lane, NOT the in/out range two lines up:
    // "mark" and "marker" share a root in English and name two different
    // objects here, so a translation must keep them apart.
    seek_prev_marker: "Go to previous marker",
    seek_next_marker: "Go to next marker",
    clear_range: "Clear in/out points",
    open_search: "Search everything…",
    search: "Search",
  },
  // The second line under an action in Settings → Keyboard. Only the actions
  // whose handler dispatches on which selection is armed carry one: their label
  // can name just one of the two things the key does, so the hint is where the
  // rule itself is stated.
  hints: {
    nudge_back:
      "Moves the selected keyframes one frame earlier; with no keyframes selected, slips the selected audio one sample.",
    nudge_forward:
      "Moves the selected keyframes one frame later; with no keyframes selected, slips the selected audio one sample.",
    nudge_large_back:
      "Moves the selected keyframes ten frames earlier; with no keyframes selected, slips the selected audio one millisecond.",
    nudge_large_forward:
      "Moves the selected keyframes ten frames later; with no keyframes selected, slips the selected audio one millisecond.",
    delete_selected:
      "Deletes the selected keyframes when any are selected, else the selected clips. A selected gap closes instead — everything after it moves left.",
    ripple_delete_selected:
      "Selected keyframes and a selected transition take this key first, as they do for Delete; otherwise the selected clips go and everything after them moves left. A selected gap closes.",
    copy_selected:
      "Copies the selected keyframes when any are selected, else the selected clip.",
    paste_at_playhead:
      "Pastes copied keyframes onto the selected clips at the playhead, else pastes the copied clip.",
  },
  // The ✕ every AppDialog draws in its own header. One key, not one per
  // feature area: the glyph dismisses the DIALOG, so the wording is the same
  // everywhere and the footer button keeps the contextual verb (Cancel /
  // Stay / Keep). Distinct from `window_controls.close`, which quits the app.
  modal: {
    close: "Close",
  },
  dialogs: {
    save_title: "Save WeftCut project",
    project_filter: "WeftCut project",
    save_default_name: "untitled.vproj",
    import_title: "Import media",
    media_filter: "Media files",
  },
  media_pool: {
    empty: "No media imported yet.",
    search_placeholder: "Search media…",
    no_matches: "No matches for “{{query}}”.",
    clear_search: "Clear search",
    // The pool's session filter. Says "unused", not "isolated": on a Group the
    // state is a remnant, on a media item it is merely never-placed, and the
    // word that covers both is the neutral one.
    unused_filter: "Show only unused",
    // Its own dead end, kept apart from `empty` — a pool full of used media
    // must never print "No media imported yet."
    no_unused: "Everything in the pool is used somewhere.",
    layout_label: "Layout",
    layout_large: "Large cards (one per row)",
    layout_grid: "Grid (fixed-size cards)",
    layout_list: "List",
    no_duration: "—",
    importing: "Copying…",
    importing_cancel_hint: "Cancel import",
    missing: "Missing",
    missing_hint: "Source file not found: {{path}}",
    proxy_pending: "Preparing…",
    proxy_pending_hint: "Preview is being prepared…",
    proxy_failed: "Preview failed",
    proxy_failed_hint: "Preview could not be prepared. Re-import to retry.",
    optimizing: "Optimizing in background",
    optimizing_hint:
      "Editable now · optimized media is building in the background; export waits for it automatically.",
    card_ready_hint: "Drag onto a track to add · right-click for media actions",
    drop_to_import: "Drop files to import",
    proxy_mode_auto: "Auto",
    proxy_mode_auto_hint: "Follow the project's Prefer-proxies setting.",
    proxy_mode_proxy: "Proxy",
    proxy_mode_proxy_hint: "Always preview this clip from its 720p proxy.",
    proxy_mode_original: "Original",
    proxy_mode_original_hint: "Always preview this clip from the original.",
    actions_for: "Media actions for {{label}}",
    proxy_heading: "Preview source",
    analyze_shots: "Analyze shots",
    analyze_shots_running: "Analyzing…",
    analyze_shots_hint: "Detect shot cuts for this clip",
    remove_menu: "Remove from media pool",
    remove_wait_for_import: "Wait for the import to finish or cancel it first",
    remove_title: "Remove media?",
    remove_body: "Remove “{{label}}” from this project?",
    remove_unused_note:
      "The source file will stay on disk. Removing unused media cannot be undone.",
    remove_in_use_title: "Media is in use",
    remove_in_use_body_one:
      "“{{label}}” is used by {{count}} timeline clip. Removing it will also remove:",
    remove_in_use_body_other:
      "“{{label}}” is used by {{count}} timeline clips. Removing it will also remove:",
    remove_in_use_note:
      "This timeline change can be undone. The source file will stay on disk.",
    // Last rungs of a reference row's naming chain, for a layer the renderer's
    // snapshot cannot place (`panels/mediaReferences.ts`).
    reference_unknown_layer: "Clip {{id}}",
    reference_unknown_track: "Unknown track",
    remove_cancel: "Cancel",
    remove_confirm: "Remove",
    remove_force_confirm_one: "Remove media + {{count}} clip",
    remove_force_confirm_other: "Remove media + {{count}} clips",
    removing: "Removing…",
    remove_failed: "Could not remove media: {{detail}}",
    // Group cards, in the same pool list as the media ones.
    // A composition whose last inner layer was deleted. It has no window to
    // place, so the card is not draggable — the hint is what says why.
    groups_empty_hint: "This Group is empty. Open it and add a clip first.",
    groups_card_hint:
      "Drag onto a track to place another instance · double-click to open · right-click for Group actions",
    // A composition no Group clip references. Not "unused": everything in the
    // pool is unused until it is placed, and this state means the opposite —
    // it WAS placed, the last clip is gone, and the composition is now the only
    // thing holding it.
    groups_isolated: "isolated",
    groups_refs_one: "{{count}} ref",
    groups_refs_other: "{{count}} refs",
    groups_actions_for: "Group actions for {{label}}",
    groups_delete: "Delete Group",
    groups_delete_hint: "Remove this Group from the project",
    groups_delete_in_use:
      "Still shown by a Group clip. Delete those clips, or ungroup them, first.",
    groups_rename_title: "Rename Group",
    groups_rename_confirm: "Rename",
  },
  preview: {
    edit_text: "Edit text",
    empty_hint: "Add a clip to start the preview",
    preparing: "Preparing preview…",
    // What the preview renders. The list names the timeline and every Group;
    // the default follows whichever timeline holds the keyboard.
    target_label: "What the preview shows",
    target_follow_focus: "Follow focus",
    // Percentages are composition pixels per device pixel, so 100 % is the
    // "actual detail" reading. Fit is a mode, not a percentage: it re-fits
    // when the panel is resized.
    zoom_label: "Preview zoom",
    zoom_fit: "Fit",
    zoom_percent: "{{percent}}%",
  },
  timeline: {
    empty_placeholder: "timeline (import a clip or pick a motif to populate)",
    empty_ab_roll:
      "No A/B-roll content here. Drop a clip on $t(tracks.roles.a-roll) or $t(tracks.roles.b-roll), or press {{key}} to switch to All Tracks.",
    resize_track_hint: "Drag to resize this track",
    track_eye_hint: "Hide this track's output (affects export)",
    track_lock_hint: "Lock this track against edits",
    drop_collision: "Overlaps existing media",
    drop_locked: "Track is locked",
    // The selected gap's tooltip — the shape a clip's own title has (`Video:
    // start → end`), with the gap named where the kind would be.
    gap_title: "Gap: {{start}} → {{end}}",
    // A Group released inside itself, or inside a Group it already contains.
    drop_cycle: "A Group cannot contain itself",
    drop_spawn_hint: "Release to create a track",
    toggle_keyframe_lanes: "Expand keyframe lanes",
    mode_ab_roll_hint: "A/B Roll, other tracks hidden. Click to show all.",
    mode_all_tracks_hint: "All Tracks, nothing hidden. Click for A/B Roll.",
    // Context-menu entries for the right-click menu on layers.
    separate_audio: "Separate audio to new track",
    prebake_now: "Pre-bake now",
    mark_shot_cuts: "Mark shot cuts",
    mark_shot_cuts_hint:
      "Detect this clip's shot boundaries and drop a marker on each.",
    rename: "Rename",
    rename_link: "Rename link…",
    // The Group rows, gated on the right-clicked clip's kind.
    open_group: "Open group",
    rename_group: "Rename group…",
    // Accessible name for the Group clip's inline composition-name editor.
    group_label: "Group name",
    // A Group with no stored name. The number is its creation order among the
    // unnamed ones (`lib/layerName.ts`), which is what makes two unnamed
    // Groups tellable apart on the timeline.
    group_derived_name: "Group {{n}}",
    // The two source-window affordances on a Group clip. Hatched tail: the
    // composition is shorter than the window, so the clip's end shows nothing.
    // Tick: the composition is longer, so there is content to trim out to.
    group_overhang: "Past the end of {{label}} — nothing renders here",
    group_more_content: "{{label}} runs longer — drag this edge out for more",
    // Tooltip of the `⚑N` badge on a Group clip. The count reaches through
    // every composition nested inside, so the sentence says "inside" rather
    // than naming a timeline — the marks are not all on one.
    group_marker_count_one: "{{count}} marker inside — click to open this group",
    group_marker_count_other:
      "{{count}} markers inside — click to open this group",
    // Accessible name for the label tab's inline editor.
    link_label: "Link name",
    // Tooltip of the `+N` badge on a link whose members sit on filtered lanes.
    link_hidden_members_one:
      "{{count}} linked clip on a hidden track — click to reveal it",
    link_hidden_members_other:
      "{{count}} linked clips on hidden tracks — click to reveal the next",
    // The marker menu names its subject: its target is a ~5 px glyph, so a
    // bare "Delete" would leave "of what?" to a tooltip the menu just covered.
    delete_marker: "Delete marker",
    // The two anchoring rows, in the glossary's words (CONTEXT.md). "Attach to
    // clip" names its target the way "Delete marker" does — the row acts on the
    // marker but what it needs from the user is a clip.
    attach_marker: "Attach to clip",
    detach_marker: "Detach",
    // Accessible name for the lane header's inline rename field — the visible
    // label it replaces is the lane's own name.
    rename_track_label: "Rename {{label}}",
    enable_layer: "Enable clip",
    disable_layer: "Disable clip",
    // The row's label when the toggle fans out across the link: the count says
    // what one click will touch. `_one` never renders (a fan-out is ≥ 2) but
    // completes the plural pair.
    enable_linked_layers_one: "Enable {{count}} linked clip",
    enable_linked_layers_other: "Enable {{count}} linked clips",
    disable_linked_layers_one: "Disable {{count}} linked clip",
    disable_linked_layers_other: "Disable {{count}} linked clips",
    bake_dot_warming: "Warming…",
    bake_dot_baking: "Pre-baking…",
    bake_dot_ready: "Pre-baked",
    bake_dot_error: "Pre-bake failed",
    audio_slipped: "Audio slipped {{offset}} from its video",
    audio_units: "Audio units",
    audio_units_frames: "Timecode (HH:MM:SS:FF)",
    audio_units_ms: "Milliseconds (HH:MM:SS.mmm)",
    audio_units_samples: "Samples (48 kHz)",
    // Transition create entries — shown when the right-click lands within
    // the tolerance band of a cut between adjacent visual layers.
    add_transition_crossfade: "Add crossfade",
    add_transition_wipe: "Add wipe · {{direction}}",
    add_transition_slide: "Add slide · {{direction}}",
    transition_chip_title: "{{kind}} transition · {{start}} → {{end}}",
    // Chip context-menu submenu triggers; kind/direction values reuse
    // `transitions.*`, delete reuses `property_panel.transition_delete`.
    transition_menu_kind: "Kind",
    transition_menu_direction: "Direction",
    transition_menu_duration: "Duration",
    transition_menu_duration_preset: "{{seconds}} s",
    // The marker lane's own header cell: what the row under the ruler is.
    marker_lane: "Markers",
    // Hover text for a mark in the marker lane; `label` falls back to
    // `$t(kinds.marker)` at the call site. Which pattern a marker gets is
    // MarkerLane.tsx's `markerTitle`.
    marker_tooltip_point: "{{label}} · {{timecode}}",
    marker_tooltip_region: "{{label}} · {{start}} – {{end}}",
  },
  // Derived track names (`lib/trackName.ts`): what a lane is called when the
  // user has not named it. Kebab role keys so the lookup is the wire value
  // itself. Nested into `timeline.empty_ab_roll` with `$t(…)` so the hint names
  // lanes the way their headers do instead of quoting one language.
  tracks: {
    roles: {
      "a-roll": "A roll",
      "b-roll": "B roll",
      "audio-a": "A roll audio",
      "audio-b": "B roll audio",
      caption: "Captions",
    },
    positional: "Track {{n}}",
  },
  transitions: {
    kind_crossfade: "Crossfade",
    kind_wipe: "Wipe",
    kind_slide: "Slide",
    // Direction = MOTION direction (industry convention): "Wipe left" sweeps
    // the reveal boundary right-to-left; "Slide left" enters from the right.
    direction_left: "Left",
    direction_right: "Right",
    direction_up: "Up",
    direction_down: "Down",
    // Why the apply surfaces (strip button, panel cards) are disabled —
    // shared so every outlet explains the same precondition the same way.
    no_target: "No cut between two adjacent visual clips",
    // The Transitions panel's empty-state teaching line: the panel exists for
    // users who don't know the feature, so the precondition is spelled out.
    panel_no_target_hint:
      "Place two visual clips back-to-back on a track, then pick a style below.",
    // Failure copy moved to `errors.*` (errors/formatCommandError.ts).
  },
  playhead_panel: {
    section_label: "Hidden-track clips near playhead",
    // A row's leading time value: unit letters, not a timecode (see
    // `formatPlayheadDelta`). The phrase around the value is what saves every row a
    // printed field name, so a translation has to keep the relation it states —
    // reducing any of these to the bare number puts the ambiguity back.
    delta_frames: "{{f}}f",
    delta_sec_frames: "{{s}}s {{f}}f",
    delta_min_sec: "{{m}}m {{s}}s",
    delta_hour_min: "{{h}}h {{m}}m",
    delta_future: "in {{value}}",
    delta_past: "{{value}} ago",
    delta_remaining: "{{value}} left",
    // The field names themselves, spent where they cost no width: the
    // accessible name and the hover title. The printed value stays terse; these
    // say in full what it measures.
    delta_future_aria: "Starts {{value}} after the playhead",
    delta_past_aria: "Ended {{value}} before the playhead",
    delta_remaining_aria: "{{value}} left to play",
    duration_aria: "Duration {{value}}",
    // The ±Δ window dial. `value` is pre-formatted (playheadItems.ts) and never a
    // count, so these keys take no i18next plural suffixes.
    window_label: "Playhead window",
    window_seconds: "{{value}}s",
    window_minutes: "{{value}}min",
    // The chips are checkboxes in any combination, and checking none is the
    // unfiltered state — so `filter_empty` must describe a set, not one kind.
    filter_label: "Filter near-playhead items by kind",
    cat_video: "Video",
    cat_audio: "Audio",
    cat_text: "Text",
    filter_empty: "Nothing of the checked kinds near the playhead",
    section_at_playhead: "Now playing",
    section_nearby: "Nearby",
    at_playhead_empty: "Nothing is playing right now",
    goto: "Go to {{label}}",
    rename_label: "Rename {{label}}",
    restack_grip: "Drag to restack {{label}}",
    row_menu: "Restack {{label}}",
    restack_forward: "Bring forward",
    restack_backward: "Send backward",
    restack_front: "Bring to front",
    restack_back: "Send to back",
    // Folded link rows. `link_count_aria` names the `×N` glyph; N is the link's
    // full member count, so it is never 1.
    link_count_aria: "Link of {{count}} clips",
    expand_link: "Show the clips linked with {{label}}",
    collapse_link: "Hide the clips linked with {{label}}",
    link_menu: "Link {{label}}",
    rename_link: "Rename link…",
    unlink: "Unlink",
    all_tracks_title: "All Tracks",
    all_tracks_msg:
      "Every track is already on the timeline — nothing is hidden for this Panel to surface.",
    all_tracks_hint: "Press <key>{{key}}</key> to switch back to A/B Roll.",
    empty_title: "Nothing near the playhead",
    empty_msg:
      "No hidden-track clips fall within ±{{window}} of the playhead. Move the playhead, or widen the window above.",
  },
  agent_panel: {
  "service_unknown": "MCP status unavailable",
  "service_ready": "MCP service ready",
  "service_offline": "MCP service offline",
  "connection_settings": "Agent connection settings",
  "last_activity": "Last request · {{time}}",
  "no_connections": "No registered clients",
  "connection_note": "Registered sessions do not guarantee that a client is still online.",
  "running_count": "{{count}} operations running",
  "no_running": "No operations running",
  "end_session": "End work session",
  "end_hint": "Ends this session and releases its lock. Running tasks and later agent calls can continue.",
  "locked": "Undo is locked",
  "unlock": "Unlock undo",
  "filter": "Activity filter",
  "filter_all": "All activity",
  "filter_errors": "Failures",
  "latest": "Back to latest",
  "truncated": "{{count}} older activities are no longer shown.",
  "loading": "Loading activity…",
  "no_errors": "No failed operations.",
  "empty": "Agent activity will appear here when a client starts working.",
  "operation_count": "{{count}} activities",
  "disconnected": "Connection closed",
  "session_ended": "Session ended",
  "session_active": "Active session",
  "retention": "Recent activity from this project opening. Not restored after reopening.",
  "running": "Running",
  "done": "Completed",
  "error": "Failed",
  "reverted": "Reverted",
  "partial": "Partly reverted",
  "reads": "Project and media reads · {{count}}",
  "restored": "Restored to “{{label}}”",
  "checkpoint_missing": "Checkpoint unavailable",
  "client": "Client",
  "user": "You",
  "tool": "Tool",
  "time": "Started",
  "locate": "Locate object",
  "object_missing": "Object no longer exists",
  "arguments": "Call arguments",
  "tools": {
    "begin_agent_session": "Start work session",
    "end_agent_session": "End work session",
    "set_history_lock": "Set the undo lock",
    "analyze_clip": "Analyze clip",
    "describe_clip": "Describe clip content",
    "transcribe_clip": "Transcribe clip",
    "extract_clip_audio": "Extract clip audio",
    "analyze_shots_floor": "Detect shots",
    "compare_frames": "Compare frames",
    "detect_pauses": "Detect pauses",
    "import_media": "Import media",
    "synthesize_speech": "Synthesize speech",
    "apply_subtitles": "Apply subtitles",
    "auto_split_by_shot": "Split into shots",
    "remove_pauses": "Remove pauses",
    "ping": "Check connection",
    "resources/read": "Read resource",
    "resources/list": "List resources",
    "tools/list": "List tools",
    "prompts/list": "List prompts",
    "prompts/get": "Read prompt",
    // Mutation and history tools. The panel shows these for a call that has no
    // history label yet — refused, failed, dry-run, or still running — so each
    // one is copy, never the tool name. Verbs mirror the history labels.
    "add_track": "Add track",
    "delete_track": "Remove track",
    "rename_track": "Rename track",
    "move_track": "Move track",
    "set_track_flags": "Set track flags",
    "separate_audio_to_new_track": "Lift audio to its own track",
    "add_video_layer": "Add media clip",
    "add_color_layer": "Add color clip",
    "add_audio_layer": "Add audio clip",
    "add_text_layer": "Add text clip",
    "delete_layers": "Delete clips",
    "set_project_settings": "Update project settings",
    "apply_transcripts": "Add captions from transcript",
    "correct_caption_text": "Correct caption text",
    "restyle_captions": "Restyle captions",
    "jump_to": "Jump to history entry",
    "delete_checkpoint": "Delete checkpoint",
    "add_motif_layer": "Add motif clip",
    "add_group_layer": "Add group clip",
    "paste_layers": "Duplicate clips",
    "update_layer": "Update clip",
    "update_layer_params": "Update clip params",
    "move_layer": "Move clip",
    "trim_layer": "Trim clip",
    "split_layer": "Split clip",
    "ripple_delete_gap": "Close gap",
    "restack_layer": "Restack clip",
    "set_layers_enabled": "Enable or disable clips",
    "set_scale_linked": "Link or unlink X/Y scale",
    "create_link": "Link clips",
    "delete_link": "Unlink clips",
    "create_group": "Group clips",
    "add_group_members": "Add clips to group",
    "ungroup_layer": "Ungroup",
    "rename_composition": "Rename group",
    "move_layers_to_composition": "Move clips to timeline",
    "delete_composition": "Delete timeline",
    "update_composition": "Update timeline settings",
    "add_effect": "Add effect",
    "update_effect": "Update effect",
    "move_effect": "Reorder effect",
    "delete_effect": "Remove effect",
    "add_transition": "Add transition",
    "update_transition": "Update transition",
    "delete_transition": "Remove transition",
    "add_marker": "Add marker",
    "update_marker": "Update marker",
    "delete_marker": "Remove marker",
    "set_marker_anchor": "Tie or untie a marker",
    "set_keyframe": "Set keyframe",
    "delete_keyframe": "Remove keyframe",
    "update_link": "Update link",
    "update_keyframe": "Update keyframe",
    "read_project": "Read project",
    "clear_keyframes": "Clear keyframes",
    "smooth_keyframes": "Smooth keyframes",
    "set_param_track": "Replace param animation",
    "get_param_track": "Read param animation",
    "set_extrapolation": "Set extrapolation",
    "set_position": "Set position animation",
    "translate_path": "Move motion path",
    "set_role_gain": "Set role gain",
    "set_role_flags": "Mute or solo role",
    "delete_media": "Remove media",
    "undo": "Undo",
    "redo": "Redo",
    "create_checkpoint": "Create checkpoint",
    "restore_checkpoint": "Restore checkpoint",
    "list_checkpoints": "List checkpoints",
    "dry_run": "Dry run",
    // Motif authoring tools (`main/mcp/motifToolDefs.ts`).
    "list_motifs": "List motifs",
    "get_motif_source": "Read motif source",
    "write_motif_draft": "Write motif draft",
    "preview_motif_draft": "Preview motif draft",
    "install_motif": "Install motif",
    "delete_motif": "Delete motif"
  }
},
  agent_mode: {
    client_label: "Agent: {{client}}",
    exit: "Exit to editor",
    exit_hint: "Return to the full editor. The work session and undo lock remain unchanged.",
    empty_waiting: "Waiting for agent…",
    restore: "Restore",
    restoring: "Restoring…",
    restore_hint: "Revert the project to this checkpoint — the restore is undoable.",
    restore_locked_hint: "Locked by agent: {{reason}}",
    lock_hint: "Undo is locked. Use Unlock undo in the agent panel to release it.",
    running_pill: "Agent: {{count}} running",
    running_pill_hint: "Agent operations are still finishing in the background.",
    restored_to: "Restored to \"{{label}}\"",
    manual_reason: "Manual session",
    resize_record_panel: "Resize record panel",
  },
  errors: {
    refresh_failed: "refresh: {{detail}}",
    // Curated refusal copy (errors/formatCommandError.ts). Names are resolved
    // before interpolation — {{incoming}}/{{blocking}}/{{layer}} are display
    // names, never uuids.
    layer_overlap:
      "Can't place “{{incoming}}” there — it would overlap “{{blocking}}” on {{track}}.",
    track_locked: "{{track}} is locked.",
    track_not_empty: "{{track}} still has clips on it.",
    track_not_removable: "{{track}} is reserved and can't be removed.",
    link_locked_member:
      "“{{layer}}” is linked with the locked clip “{{locked}}”.",
    trim_edge_out_of_range:
      "Can't trim “{{layer}}” to {{time}} — outside the clip's range.",
    split_outside_layer:
      "Can't split “{{layer}}” at {{time}} — the position is outside the clip.",
    transition_insufficient_handle:
      "“{{layer}}” has only {{available}} of source handle — not enough for this transition.",
    transition_restore_collision:
      "Removing the transition needs to move “{{layer}}” back to the cut, but that space is now occupied.",
    transition_participants_share_link:
      "“{{from}}” and “{{to}}” are in the same link — moving one drags the other, so the overlap can't open. Unlink them first.",
    transition_layers_not_adjacent:
      "“{{from}}” and “{{to}}” must touch to add a transition.",
    // Ripple delete's four. Every one opens with the same four words, because
    // these lines are read in two places — the status bar after the fact, and a
    // greyed row's tooltip before it — and the shared opening is what makes the
    // tooltip legible as "this is why the ripple is off" rather than as a
    // sentence about a clip.
    ripple_inside_hole:
      "Ripple delete blocked: {{layer}} starts inside the span being closed — add it to the selection, or delete without ripple.",
    ripple_collision:
      "Ripple delete blocked: {{moving}} would land on {{blocking}}.",
    ripple_link_straddles:
      "Ripple delete blocked: link {{link}} has members on both sides of the cut.",
    ripple_locked_layer:
      "Ripple delete blocked: {{layer}} is locked and would have to move.",
    // The gap's own refusal (ADR 0069): the span the renderer selected is no
    // longer a gap by the time the actor reads it — a clip moved into it, or
    // an edge moved. Same four-word opening as the ripple's, since it greys the
    // same row and lands on the same status bar.
    gap_not_found:
      "Ripple delete blocked: the selected gap on {{track}} is no longer there.",
    fps_locked_by_content:
      "Frame rate stays {{current}} fps — the timeline still holds {{layers}} clip(s).",
    fps_locked_by_content_history:
      "Frame rate stays {{current}} fps — undo history still holds clips (reopen the project to clear it).",
  },
  language: {
    switch_label: "Language",
  },
  window_controls: {
    minimize: "Minimize",
    maximize: "Maximize",
    restore: "Restore",
    close: "Close",
  },
  close_guard: {
    title: "Export in progress",
    body: "An export is still running. Quitting now will abort it and leave a partial output file.",
    stay: "Keep exporting",
    quit: "Quit anyway",
  },
  transport: {
    play_pause_hint: "Play / pause",
    to_start_hint: "Jump to start",
    to_end_hint: "Jump to end",
    timecode_label: "Current time",
    timecode_edit_hint: "Click to edit · Enter to seek · Esc to cancel",
    dropped_frames_one:
      "{{count}} frame dropped during playback — decoding fell behind",
    dropped_frames_other:
      "{{count}} frames dropped during playback — decoding fell behind",
    late_frames_one:
      "{{count}} frame late during playback — the render loop stalled",
    late_frames_other:
      "{{count}} frames late during playback — the render loop stalled",
  },
  export: {
    title: "Export",
    phase_encode: "Encoding",
    starting: "Starting export…",
    preparing:
      "Preparing optimized media for {{labels}} — export will start automatically.",
    preparing_cancel: "Cancel",
    failed_prepare:
      "Couldn't prepare {{labels}} for export — the file may be corrupt or unsupported. Re-import it and try again.",
    failed_audio_fx:
      'audio effect "{{effect}}" on "{{layer}}": {{message}}',
    failed_audio_fx_chain: 'audio effects on "{{layer}}": {{message}}',
    no_video_material:
      "No video to export: the selected range has no visible clips.",
    no_audio_material:
      "No audio to export: the selected range has no audio.",
    progress_label:
      "{{percent}}% · frame {{frame}} · {{fps}}fps · {{speed}}x",
    phase_finalize: "Finalizing",
    finalize_sink: "Flushing the encoder…",
    finalize_audio: "Rendering audio…",
    finalize_mux: "Writing the output file…",
    complete: "Exported to {{path}}",
    failed: "Export failed: {{detail}}",
    dismiss: "Dismiss",
    play: "Play",
    play_hint: "Open the exported file in a Render & Play window.",
    // Named per OS the way Premiere / Resolve label it (see ExportPanel's
    // REVEAL_KEY); Linux has no single file manager to name, and does not
    // select the file (main/openPath.ts), so its label promises less.
    reveal_windows: "Reveal in Explorer",
    reveal_mac: "Reveal in Finder",
    reveal_linux: "Show in folder",
    reveal_hint: "Open the folder containing the exported file.",
    render_play_title: "WeftCut — Render & Play",
    notify_done_title: "Export finished",
    notify_done_body: "Saved to {{path}}",
    notify_failed_title: "Export failed",
    notify_failed_body: "{{detail}}",
  },
  export_dialog: {
    title: "Export settings",
    cat_general: "General",
    cat_video: "Video",
    cat_audio: "Audio",
    cat_subtitle: "Subtitle",
    subtitle_placeholder: "Subtitle export is coming soon.",
    content: "Export content",
    include_video: "Include video",
    include_audio: "Include audio",
    content_none: "Select at least video or audio to export.",
    video_excluded:
      "Video isn't included in this export. Change “Export content” under General to include it.",
    audio_excluded:
      "Audio isn't included in this export. Change “Export content” under General to include it.",
    resolution: "Resolution",
    fps: "Frame rate",
    follow_comp: "Follow timeline",
    codec: "Codec",
    container: "Container / Muxer",
    encoder_engine: "Encoder engine",
    engine_auto: "Auto",
    engine_native: "Native (FFmpeg)",
    engine_webcodecs: "WebCodecs",
    path_native: "Encoder: native FFmpeg (full control, explicit color tags)",
    path_webcodecs: "Encoder: WebCodecs (hardware if available)",
    // Engine option labels + unavailable reason reuse settings.decode_engine_*
    // so preview and export read identically.
    decode_engine: "Decode engine",
    decode_summary:
      "Decode: {{originals}} source(s) from originals, {{proxy}} from lossy proxy",
    checking_codec: "Checking codec support…",
    codec_unsupported:
      "{{codec}} can't be encoded on this machine — pick another codec.",
    prores_profile: "ProRes profile",
    dnxhr_profile: "DNxHR profile",
    quality: "Quality",
    quality_low: "Low",
    quality_medium: "Medium",
    quality_high: "High",
    quality_custom: "Custom",
    target_bitrate: "Target bitrate",
    max_bitrate: "Maximum bitrate",
    max_bitrate_unlimited:
      "Peak uncapped — the encoder may spike well above the target on hard scenes. Set a maximum to bound it.",
    max_bitrate_below_target:
      "The maximum must be at least the target bitrate. Below it, the encoder abandons the target and the file comes out at the maximum.",
    buffer_size: "Buffer size",
    buffer_size_auto:
      "Buffer follows the ceiling (2×). A smaller buffer tracks the ceiling more tightly and swings quality more; a larger one is looser.",
    cbr_hint:
      "CBR holds this bitrate throughout: the maximum and minimum are pinned to it, so quality varies with scene difficulty.",
    rate_constraints_native_only:
      "Maximum bitrate and buffer size need the native FFmpeg encoder — WebCodecs exposes only a target bitrate.",
    mbps: "Mbps",
    mbit: "Mbit",
    rate_mode: "Rate control",
    rate_vbr: "VBR (variable)",
    rate_cbr: "CBR (constant)",
    rate_quality: "Quality (CRF)",
    crf: "CRF",
    keyframe_interval: "Keyframe interval",
    encoder_accel: "Video encoder",
    encoder_auto: "Auto (prefer hardware)",
    encoder_software: "Software",
    speed_preset: "Encoder preset",
    preset_fast: "Fast",
    preset_medium: "Medium",
    preset_slow: "Slow (best quality/size)",
    location: "Location",
    filename: "File name",
    choose_location: "Choose output folder",
    browse: "Browse…",
    cancel: "Cancel",
    export: "Export",
    range: "Range",
    range_full: "Whole project",
    range_marked: "In/out range",
    range_marked_none:
      "No in/out points marked on the timeline. Mark a span with the Quick Actions strip or the I / O keys.",
    range_custom: "Custom",
    range_in: "In",
    range_out: "Out",
    range_invalid:
      "This range is empty, or lies entirely outside the project. Check the in and out points.",
    audio_codec: "Audio codec",
    audio_bitrate: "Audio bitrate",
    audio_channels: "Channels",
    audio_sample_rate: "Sample rate",
    channels_mono: "Mono",
    channels_stereo: "Stereo",
    bit_depth: "Bit depth",
    bit_depth_8: "8-bit",
    bit_depth_10: "10-bit (HEVC Main10 / AV1) — experimental",
    bit_depth_hint: "Timeline has 10-bit sources — 10-bit output preserves their precision.",
    bit_depth_experimental_warning:
      "10-bit export is experimental. The preview is shown in standard 8-bit, so on-screen colors and gradients may not match the final 10-bit file — HDR / wide-gamut preview isn't possible on the web platform yet. It also runs well below realtime and may fail or produce incorrect output on some sources.",
    experimental_title: "10-bit export is experimental",
    experimental_body:
      "This feature is still experimental and may fail or produce incorrect output:",
    experimental_point_preview:
      "The preview is shown in 8-bit/SDR and can't be guaranteed to match the actual 10-bit result — color, gradients, and HDR may differ.",
    experimental_point_slow:
      "Software 10-bit decode runs well below realtime — 4K or long projects can be very slow.",
    experimental_point_reliability:
      "Some sources (e.g. HEVC Main10 originals) get transcoded and may be less reliable.",
    experimental_proceed: "Export anyway",
    native_unavailable_fallback:
      "The native FFmpeg encoder is unavailable. Export with the WebCodecs encoder instead? (Bitrate mode only; color tags rely on defaults.)",
    native_unavailable_no_fallback:
      "The native FFmpeg encoder is unavailable and this format has no WebCodecs fallback.",
  },
  app_notice: {
    dismiss: "Got it",
    keyring_unavailable: {
      title: "Cloud API keys aren't encrypted",
      body: "No OS keyring is available, so cloud API keys are saved to disk without encryption (cloud_keys.json). Install a keyring (e.g. GNOME Keyring / KWallet), or protect your user-data folder.",
      action: "Open API key settings",
    },
    native_decode_unavailable: {
      title: "Native decode engine unavailable",
      body: "The native decode component (@weftcut/native-decode) failed to load, so previews use the WebCodecs engine only. Reinstall the app to restore it.",
      action: "Open decode settings",
    },
    agent_skill_unavailable: {
      title: "Agent Skill missing",
      body: "The Skill that teaches a connected agent how to drive WeftCut did not install, so there is nothing to hand to your agent. Reinstall the app to restore it.",
      action: "Open agent settings",
    },
    agent_skill_stale: {
      title: "Agent Skill not up to date",
      body: "WeftCut could not refresh its agent Skill, so the copy on offer is one an earlier version left behind. An agent using it may call tools this version no longer has.",
      action: "Open agent settings",
    },
  },
  // Codec-named optimization reasons, shown in Media Pool badge tooltips.
  import_proxy: {
    checking_one: "Checking this clip…",
    reason_undecodable: "{{codec}} · can't be decoded on this machine",
    reason_transcode: "{{codec}} · needs transcoding",
    reason_10bit: "{{codec}} 10-bit/HDR · needs optimizing",
    reason_bridged: "{{codec}} · usable now, optimizing scroll in background",
    failed: "Preparation failed — re-import to retry",
    failed_log: "Optimizing “{{label}}” failed — re-import it to retry.",
  },
  motif_stale: {
    title: "Motifs changed since you placed them",
    entry: "v{{from}} → v{{to}} ({{n}} clips)",
    note: "These clips already render with the current version — this is just a heads-up.",
    dismiss: "Got it",
  },
  connect: {
    blurb:
      "Connect an external agent to WeftCut's local MCP server so it can read and edit your project directly.",
    starting: "MCP server starting…",
    copy: "Copy config",
    copied: "Copied!",
    copy_prompt: "Copy setup prompt",
    prompt_copied: "Prompt copied!",
    prompt_heading: "Let your agent set itself up",
    prompt_blurb:
      "For agents that support MCP: paste the prompt into the chat and it configures the MCP connection and installs the Skill. The Skill updates with each release, so reinstalling after every upgrade is recommended.",
    manual_heading: "Prove you're human",
    skill_path_heading: "Skill folder location",
    skill_path_unavailable:
      "No Skill folder to open — see “Let your agent set itself up” above.",
    skill_stale:
      "Showing the copy an earlier launch left behind, which may be older than this version of WeftCut.",
    skill_retry: "Try again",
    skill_retrying: "Installing…",
    skill_fault: {
      not_built:
        "This development build has no Skill staged yet. Run “npm run build:skills” and restart.",
      bundle_missing:
        "No Skill shipped with this installation of WeftCut. Reinstall the app to restore it.",
      incomplete:
        "The Skill that shipped with WeftCut is incomplete. Reinstall the app to restore it.",
      copy_failed:
        "WeftCut could not write the Skill into its user-data folder. Check free disk space and the folder's permissions, then restart.",
    },
    copy_path: "Copy path",
    browse: "Browse…",
    // The Browse button's tooltip — Windows' own Explorer wording, and true on
    // all three: the file manager comes up on the folder (selected where the
    // platform can — see main/openPath.ts).
    open_location: "Open file location",
    agent_prompt: [
      "Configure the WeftCut MCP server for me. Make the configuration change directly; do not just describe the steps.",
      "",
      "Connection details:",
      "- Server name: weftcut",
      "- Transport: streamable HTTP",
      "- URL: {{url}}",
      "- Authorization header: Bearer {{token}}",
      "",
      "Requirements:",
      "- Use your client's official MCP config format and location.",
      "- Inspect the existing configuration first and preserve all other settings and MCP servers.",
      '- Add or update only the MCP server named "weftcut"; do not replace the whole configuration file.',
      "- Keep the bearer token private and do not echo it in your response.",
      "- Validate the resulting configuration syntax. If the client must be restarted, tell me.",
      "- Report which file you changed and whether the configuration is valid.",
    ].join("\n"),
    agent_prompt_stdio: [
      "Configure the WeftCut MCP server for me. Make the configuration change directly; do not just describe the steps.",
      "",
      "Connection details:",
      "- Server name: weftcut",
      "- Transport: stdio (local command)",
      "- Command: {{command}}",
      "- Args: {{args}}",
      "- Env: ELECTRON_RUN_AS_NODE=1, WEFTCUT_USERDATA={{userData}}",
      "",
      "Requirements:",
      "- Use your client's official MCP config format and location.",
      "- Inspect the existing configuration first and preserve all other settings and MCP servers.",
      '- Add or update only the MCP server named "weftcut"; do not replace the whole configuration file.',
      "- Keep the command, args, and env values exactly as given — they are machine-specific paths.",
      "- Validate the resulting configuration syntax. If the client must be restarted, tell me.",
      "- Report which file you changed and whether the configuration is valid.",
    ].join("\n"),
    // The second half of the setup prompt, appended after whichever MCP block
    // applies. It stands on its own so the message still reads when there is no
    // staged Skill folder to hand over and this half is left out.
    agent_prompt_skill: [
      "Then install the WeftCut Skill — the usage guidance that ships with the app.",
      "",
      '- Copy the folder "{{folder}}" into your own skills directory, keeping the folder name weftcut. For Claude Code that is ~/.claude/skills/weftcut.',
      "- Overwrite any copy already sitting there; it belongs to an older version of WeftCut.",
      "- Read the Skill once it is in place, and follow it whenever you work on a WeftCut project.",
      "- Report where you installed it.",
    ].join("\n"),
    reveal: "Reveal token",
    hide: "Hide token",
    refresh: "Refresh token",
    refreshing: "Refreshing…",
    refresh_hint: "Generate a new bearer token and persist it",
    refresh_confirm:
      "Generate a new bearer token? Any agent using the current token will need its config updated.",
    token_note:
      "MCP requests must carry the token, and the server binds to local use only. The token is stored in mcp_auth.json — if it leaks, use Refresh token to rotate it.",
    snippets_heading: "Client config snippets",
    stdio_note:
      "This configuration stays valid long-term: app restarts, port changes and token changes require no edits. Agents can also connect while WeftCut is closed, and launch it directly.",
    http_heading: "HTTP direct (advanced)",
    http_note:
      "Connects directly to the running app. The connection drops once the app closes, and the configuration becomes invalid when the port or token changes. Unless your client does not support stdio, use the configuration above.",
    cli_note: "Or run the following command in a terminal",
    copy_command: "Copy command",
    tabs: {
      codex: "Codex",
      claude: "Claude",
      cursor: "Cursor",
      generic: "Generic",
    },
    hint: {
      codex: "Paste into ~/.codex/config.toml",
      claude: "Paste into .mcp.json (project) or ~/.claude.json",
      cursor: "Paste into ~/.cursor/mcp.json or a project's .cursor/mcp.json",
      generic:
        "Connection details — refer to your client's own docs to fill in each value.",
    },
    hint_stdio: {
      codex: "Paste into ~/.codex/config.toml",
      claude: "Paste into .mcp.json (project) or ~/.claude.json",
      cursor: "Paste into ~/.cursor/mcp.json or a project's .cursor/mcp.json",
      generic:
        "Connection details — refer to your client's own docs to fill in each value.",
    },
  },
  settings: {
    heading: "Settings",
    cat_general: "General",
    cat_project: "Project",
    cat_keyboard: "Keyboard",
    cat_speech: "Transcription",
    cat_vlm: "Video understanding",
    cat_agent: "Agent",
    project_scope_blurb:
      "Settings on this page apply to the current project only and are saved with the project file.",
    startup_heading: "Startup",
    reopen_on_launch: "Auto-open last project",
    reopen_on_launch_hint:
      "When enabled, WeftCut skips the start screen and auto-opens the last used project.",
    canvas_heading: "Canvas",
    canvas_blurb:
      "This project's editing and preview size, and its timeline frame rate.",
    canvas_lock: "Lock canvas settings",
    canvas_lock_hint:
      "Canvas settings are project setup, not edits — they cannot be undone.",
    canvas_resolution: "Resolution",
    canvas_resolution_custom: "Custom",
    canvas_custom_size: "Custom size",
    canvas_width: "Width",
    canvas_height: "Height",
    canvas_apply: "Apply",
    canvas_fps: "Frame rate",
    canvas_fps_hint:
      "The frame rate can only be changed in a project whose timeline has never had content.",
    duration_heading: "Duration",
    duration_blurb:
      "Duration follows the last visible frame by default. Extend it to hold a fixed runtime longer than the content.",
    pin_composition_duration: "Extend duration",
    pin_composition_duration_hint:
      "Holds it at the value below. Can only be set ≥ {{floor}} (content end).",
    composition_duration_label: "Duration",
    composition_duration_invalid: "Invalid timecode.",
    composition_duration_below_floor: "Must be ≥ {{floor}} (content end).",
    duration_wall_clock:
      "This rate is non-drop-frame: {{tc}} is {{wall}} of real time.",
    content_end_wall_clock: "Content end {{tc}} is {{wall}}.",
    timeline_heading: "Timeline",
    timeline_wheel_axis: "Mouse wheel scrolls",
    timeline_wheel_axis_horizontal: "Along time (horizontal)",
    timeline_wheel_axis_vertical: "Across tracks (vertical)",
    timeline_wheel_axis_hint:
      "Shift+wheel always scrolls the other axis. Ctrl+wheel and Alt+wheel zoom.",
    tail_snap_enabled: "Clip snapping",
    tail_snap_enabled_hint:
      "Snap clips to nearby clip edges or the playhead while dragging or trimming.",
    tail_snap_strength: "Snap strength",
    tail_snap_strength_hint:
      "Measured in screen pixels.",
    playback_heading: "Playback",
    prefer_proxies: "Prefer proxies for preview",
    prefer_proxies_hint:
      "Play the lightweight 720p proxy in the preview for clips that have one, for smoother scrubbing. Export still uses the original.",
    decode_unsupported_generate_proxy: "Generate proxy",
    keybindings_blurb:
      "Manage your keyboard shortcut configuration table.",
    configured: "Configured",
    not_configured: "Not configured",
    placeholder_set: "Replace key…",
    placeholder_unset: "Paste API key",
    save: "Save",
    saving: "Saving…",
    clear: "Clear",
    clearing: "Clearing…",
    saved: "Saved!",
    cleared: "Cleared!",
    test: "Test",
    testing: "Testing…",
    test_hint:
      "Run a cheap API call to confirm the saved key works. Surfaces InvalidKey / rate-limit errors before your first cloud-backed agent call.",
    speech_blurb:
      "Turn speech in audio and video into text for subtitles and media search. Supports local models and online services.",
    speech_engine: "Transcription engine",
    speech_engine_auto: "Automatic",
    speech_engine_soon: "coming soon",
    speech_engine_active: "Active engine: {{engine}}",
    speech_engine_none:
      "No engine configured — add an API key or a local engine's binary + model below.",
    speech_available: "Available",
    speech_needs_key: "Needs API key",
    speech_needs_binary: "Needs binary",
    speech_needs_model: "Needs model",
    speech_binary: "Binary",
    speech_binary_placeholder: "Path to the engine CLI (e.g. whisper-cli)",
    speech_model: "Model",
    speech_model_placeholder: "Path to the model file (e.g. ggml-base.bin)",
    speech_tokens: "Tokens",
    speech_tokens_placeholder: "Path to tokens.txt (FunASR / sherpa-onnx)",
    speech_device: "Device",
    speech_device_placeholder: "optional (e.g. cpu, cuda)",
    speech_threads: "Threads",
    speech_browse: "Browse…",
    speech_pick_binary: "Choose the engine binary",
    speech_pick_model: "Choose the model file",
    speech_pick_tokens: "Choose the tokens file",
    speech_test_hint:
      "Check the binary runs and the model file is present, without transcribing anything.",
    speech_test_unsaved_hint:
      "Save the paths first — Test checks the saved configuration.",
    speech_exact_words: "exact word timing",
    speech_exact_words_hint:
      "This engine reports precise per-word timestamps itself; cloud Whisper approximates them from subtitle cue spans.",
    vlm_blurb:
      "Describe video frames to help AI understand and search your media. Supports local models and online services.",
    vlm_engine: "Video-understanding engine",
    vlm_engine_auto: "Automatic",
    vlm_engine_soon: "coming soon",
    vlm_engine_active: "Active engine: {{engine}}",
    vlm_engine_none:
      "No engine configured — download or point to a local engine below, or add an OpenAI-compatible endpoint.",
    // Named for what it controls rather than for the wire field (`fps`): what a
    // user is choosing is how closely the model looks — so the unit has to ride
    // in the row, beside the number, or nothing on screen says what the count
    // counts. (`vlm_sampling_hint` below is not rendered anywhere today.)
    vlm_sampling: "Sample",
    vlm_sampling_unit: "fps",
    vlm_sampling_hint:
      "Frames per second sampled across the clip — more is finer and slower.",
    vlm_focus: "Focus",
    vlm_focus_general: "General scene",
    vlm_focus_shot_type: "Shot type and camera",
    vlm_focus_hint:
      "What the tags lean toward. The prose describes the scene either way.",
    // Worded by VIEW rather than by the two controls beside it: the engine, the
    // model and the interface language key the same cache, and naming only these
    // two would leave a language switch looking like lost data.
    vlm_view_note:
      "Descriptions are cached per engine, model, sampling, focus and interface language. Changing any of them switches to another description view and keeps the existing one — switch back and it is there.",
    vlm_privacy_note:
      "Frames are only ever sent to an engine you configure. Automatic prefers on-device engines and reaches an endpoint last; asking for a specific engine never falls back to a different one.",
    vlm_available: "Available",
    vlm_needs_binary: "Needs binary",
    vlm_needs_model: "Needs model",
    vlm_needs_endpoint: "Needs endpoint URL",
    vlm_binary: "Binary",
    vlm_binary_placeholder: "Path to llama-mtmd-cli",
    vlm_model: "Model",
    vlm_model_placeholder: "Path to the model GGUF",
    vlm_mmproj: "Projector",
    vlm_mmproj_placeholder: "Path to the mmproj GGUF (required for vision)",
    vlm_pick_binary: "Choose the llama-mtmd-cli binary",
    vlm_pick_model: "Choose the model GGUF",
    vlm_pick_mmproj: "Choose the mmproj (vision projector) GGUF",
    vlm_endpoint_url: "URL",
    vlm_endpoint_url_placeholder:
      "http://localhost:8080/v1/chat/completions",
    vlm_endpoint_model: "Model",
    vlm_endpoint_model_placeholder: "Model name the server serves",
    vlm_endpoint_key: "API key",
    vlm_endpoint_key_placeholder: "optional — only if the server requires one",
    content_whisper_runtime: "whisper.cpp engine (v1.9.1)",
    content_whisper_model_base: "Whisper Base model (multilingual)",
    content_funasr_runtime: "sherpa-onnx engine (v1.13.4)",
    content_funasr_model_paraformer: "Paraformer-zh model (Chinese)",
    content_llama_mtmd_runtime: "llama.cpp engine (b10103, Vulkan)",
    content_qwen3vl_model: "Qwen3-VL 4B model (Q4_K_M)",
    content_qwen3vl_mmproj: "Qwen3-VL vision projector (F16)",
    content_prereq_msvc14:
      "Requires the Microsoft Visual C++ 2015–2022 x64 runtime (usually already installed).",
    motifs_heading: "Motifs",
    prebake_motifs: "Pre-bake motifs",
    prebake_motifs_hint:
      "Background-render motif frames to disk. Smoother playback, instant reopen; uses disk space in the project Cache.",
    preview_heading: "Preview",
    preview_snap_enabled: "Preview snapping",
    preview_snap_enabled_hint:
      "Align clips to the frame's edges and centre lines, and to other clips, while moving or resizing them on the preview. Hold Ctrl to override.",
    preview_snap_strength: "Snap strength",
    preview_snap_strength_hint:
      "Measured in screen pixels.",
    decode_engine: "Decode engine",
    decode_engine_auto: "Automatic",
    decode_engine_auto_desc: "Picks the best engine for each clip",
    decode_engine_ffmpeg: "Standard",
    decode_engine_ffmpeg_tag: "ffmpeg",
    decode_engine_ffmpeg_desc: "Decodes every format, accurate colors",
    decode_engine_webcodecs: "Lite",
    decode_engine_webcodecs_tag: "webcodecs",
    decode_engine_webcodecs_desc: "Lighter on resources; supports fewer formats; colors may be slightly off",
    decode_engine_unavailable: "Standard engine unavailable: {{reason}}",
    decode_engine_unavailable_suffix: "unavailable",
    playback_resolution: "Playback resolution",
    playback_resolution_full: "Full",
    playback_resolution_half: "1/2",
    playback_resolution_quarter: "1/4",
    playback_resolution_smooth: "Smooth",
    playback_resolution_sharp: "Sharp",
    playback_resolution_export_note: "Export always renders at full resolution.",
    decode_unsupported_title: "Unsupported format",
    decode_unsupported_body:
      "The Lite engine can't decode this clip. Switch to the Standard engine to play it.",
    decode_unsupported_switch: "Switch to Standard",
    decode_unsupported_body_no_component:
      "This clip's format isn't supported by the Lite engine, and the Standard engine isn't installed.",
    data_location_heading: "Data location",
    data_location_blurb:
      "Where WeftCut keeps its large managed files. Your Motifs, partial caches, and downloaded assets will be stored here.",
    data_location_current_label: "Current folder",
    data_location_fallback:
      "Fallback — the folder you chose was unavailable, so the default is in use.",
    data_location_change: "Change…",
    data_location_open_folder: "Open folder",
    data_location_working: "Preparing…",
    data_location_phase_copy: "Copying files…",
    data_location_phase_verify: "Verifying…",
    data_location_phase_done: "Finishing…",
    data_location_progress_count: "{{copied}} / {{total}} files",
    data_location_success_copy:
      "Your data was copied to {{path}}. Restart WeftCut to start using the new location.",
    data_location_success_adopt:
      "WeftCut will use the existing data folder at {{path}}. Restart to apply.",
    data_location_restart: "Restart to apply",
    data_location_error:
      "Couldn't change the data folder: {{message}} Your data was left unchanged.",
    data_location_cleanup_title: "Delete old data copy?",
    data_location_cleanup_body:
      "WeftCut is now running on the new location. The previous copy at {{path}} is no longer used — delete it to free up space, or keep it as a backup.",
    data_location_cleanup_keep: "Keep",
    data_location_cleanup_delete: "Delete old copy",
    data_location_cleanup_deleting: "Deleting…",
  },
  keybindings: {
    add: "+ Add",
    no_binding: "(no binding)",
    remove_hint: "Remove this binding",
    reset: "Reset",
    reset_all: "Reset all",
    export: "Export…",
    import: "Import…",
    export_title: "Export keyboard shortcuts",
    import_title: "Import keyboard shortcuts",
    press_a_key: "Press a key…",
    conflict:
      "Already bound to {{action}} — unset it first.",
    reset_blocked:
      "Can't reset: {{chord}} is bound to {{action}}. Unset it first.",
  },
  colorpick: {
    pick: "Pick color",
    hint_cancel: "Esc — cancel",
    hint_screen: "S — pick from screen",
    screen_hint: "Frozen screen · Click or Enter to pick · Arrow keys to adjust · Esc to cancel",
    error_unsupported: "Screen picking is unavailable on this desktop. You can still pick inside the editor.",
    error_permission: "Allow screen recording in system settings to pick outside the editor.",
    error_capture: "Could not capture the screen. Try again, or pick inside the editor.",
    error_effect_input: "No color is available from this clip at the playhead. Cancel and move to a visible frame, or press S to pick from the screen.",
    error_timeout: "Screen picking timed out. Try again, or pick inside the editor.",
  },
  effects: {
    heading: "Effects",
    empty: "Select a clip to edit its effects.",
    add: "Add effect",
    empty_chain: "No effects on this clip yet.",
    order_hint: "Applied top to bottom.",
    drag_hint: "Drag to reorder",
    collapse: "Collapse {{name}}",
    expand: "Expand {{name}}",
    enable: "Toggle {{name}}",
    more: "More actions for {{name}}",
    move_up: "Move up",
    move_down: "Move down",
    reset_params: "Reset parameters",
    remove: "Remove {{name}}",
    key_color: "Key color",
    search_placeholder: "Search effects…",
    search_clear: "Clear search",
    no_results: "No matching effect.",
    category: {
      blur: "Blur",
      keying: "Keying",
      color: "Color",
      stylize: "Stylize",
      audio: "Audio",
    },
    audio: {
      select_region: "Select region",
      select_region_too_short: "This clip is shorter than the shortest region the filter can sample.",
      source_in: "Source in",
      source_out: "Source out",
      region_needed: "Drag a noise-only region on the clip to sample.",
      region_too_short: "The sample region is too short to learn a noise profile.",
      region_offscreen: "The sample region falls outside the part of the media this clip plays.",
      status: {
        pending: "Processing…",
        failed: "Failed: {{error}}",
      },
    },
    audio_denoise: {
      name: "Denoise",
      desc: "Remove steady background noise",
      params: {
        strength: "Strength",
        margin: "Sensitivity",
        profile_in_us: "Sample region start",
        profile_out_us: "Sample region end",
      },
    },
    blur: {
      name: "Blur",
      desc: "Gaussian softening",
      params: { strength: "Strength" },
    },
    chromakey: {
      name: "Chroma Key",
      desc: "Remove a green/blue screen",
      params: {
        keyR: "Key red",
        keyG: "Key green",
        keyB: "Key blue",
        balance: "Screen balance",
        clipBlack: "Clip black",
        clipWhite: "Clip white",
        despill: "Despill",
        feather: "Feather",
        shrink: "Shrink",
        viewMatte: "View matte",
      },
    },
    brightness: {
      name: "Brightness",
      desc: "Exposure gain — black stays black",
      params: { amount: "Amount" },
    },
    contrast: {
      name: "Contrast",
      desc: "Snap around mid gray",
      params: { amount: "Amount" },
    },
    saturation: {
      name: "Saturation",
      desc: "Color intensity, down to gray",
      params: { amount: "Amount" },
    },
    sharpen: {
      name: "Sharpen",
      desc: "Crisp soft or downscaled footage",
      params: { amount: "Amount" },
    },
  },
  property_panel: {
    // Spatial progress is a scalar track, displayed as a percentage.
    path_progress: 'Path progress (%)',
    heading: "Properties",
    empty: "Select a clip to edit its properties.",
    envelope: "Clip",
    advanced: "Advanced",
    label: "Label",
    enabled: "Enabled",
    audio_units_hint:
      "Audio edits land on exact 48 kHz samples, so these fields read and accept sub-frame times. Dragging still snaps to frames — samples are 0.042 px wide at maximum zoom. Use Alt+←/→ to nudge one sample, Alt+Shift+←/→ for 1 ms.",
    t_start: "Start",
    t_start_hint: "Inclusive — frame at this timecode is the clip's first.",
    kind: "Kind",
    link_none: "Not linked",
    link_of_one: "Link of {{count}} clip",
    link_of_other: "Link of {{count}} clips",
    link_rename: "Rename link",
    // The Group section: the composition's own name, its frame size and length
    // (both read-only here — a Group's size is copied at pre-compose), and the
    // two navigation/structure buttons.
    group: "Group",
    group_name: "Name",
    group_size: "Group size",
    group_refs: "References",
    group_open: "Open group",
    group_ungroup: "Ungroup",
    // The media branch: what an imported file IS. Read-only — the pool's
    // context menu stays the one place its preview source is chosen.
    media_resolution: "Resolution",
    media_size: "File size",
    media_location: "Location",
    media_decode: "Decode",
    media_codec: "Codec",
    media_pix_fmt: "Pixel format",
    media_color: "Color",
    media_route_bypass: "Original",
    media_route_direct_export: "Original, proxy for preview",
    media_route_proxied: "Proxy",
    media_route_native_sw: "Native software decode",
    media_proxy_ready: "proxy ready",
    media_proxy_pending: "proxy pending",
    media_usage: "Used by",
    media_unused: "Not used on any timeline.",
    media_usage_go: "Go to this clip",
    locked: "Locked",
    duration: "Duration",
    multi_primary: "Editing primary clip “{{label}}” — {{count}} clips selected; changes apply only to this clip.",
    text: "Text",
    content: "Content",
    font_family: "Font family",
    font_size_px: "Font size (px)",
    text_reduced: "auto-reduced to {{px}} px",
    text_overflowing: "overflowing — floored at {{px}} px",
    text_box_mode: "Box",
    text_box_mode_auto_width: "Auto width",
    text_box_mode_auto_height: "Auto height",
    text_box_mode_fixed: "Fixed",
    text_box_unmeasured:
      "Needs the clip's rendered size. Move the playhead over this clip, or drag a box handle in the preview.",
    text_box_w: "Box width",
    text_box_h: "Box height",
    text_box_h_hint:
      "A height turns wrapping into shrink-to-fit: the text is rendered smaller until it fits, down to 8 px.",
    align: "Horizontal align",
    align_left: "Left",
    align_center: "Center",
    align_right: "Right",
    valign: "Vertical align",
    valign_top: "Top",
    valign_middle: "Middle",
    valign_bottom: "Bottom",
    line_height: "Line height (px)",
    line_height_hint: "0 = automatic — the font's own line metrics.",
    letter_spacing: "Letter spacing (px)",
    // Width 0 is how the outline is removed; the colour row leaves with it.
    outline_width: "Outline (px)",
    outline_width_hint: "0 = no outline.",
    outline_color: "Outline color",
    color: "Color",
    // `position` / `anchor` caption a MERGED axis row; `x` / `y` / `anchor_x`
    // / `anchor_y` stay as the per-axis accessible names inside it.
    position: "Position",
    x: "X",
    y: "Y",
    opacity: "Opacity",
    media: "Media",
    audio: "Audio",
    scale_x: "Scale X",
    scale_y: "Scale Y",
    scale: "Scale",
    scale_link: "Link X/Y scale (uniform) — Scale Y becomes a copy of Scale X",
    scale_unlink: "Unlink X/Y scale",
    rotation: "Rotation (°)",
    anchor: "Anchor",
    anchor_x: "Anchor X",
    anchor_y: "Anchor Y",
    speed: "Speed",
    fade_in: "Fade in",
    fade_out: "Fade out",
    flip_h: "Flip horizontal",
    flip_v: "Flip vertical",
    width: "Width",
    height: "Height",
    gain_db: "Gain (dB)",
    pan: "Pan",
    role: "Role",
    mute: "Mute",
    transform: "Transform",
    // The Pauses section, between the kind's own sections and Advanced.
    pauses: "Pauses",
    props: "Props",
    unknown_motif: "Unknown motif — its props can't be edited here.",
    bake_warming: "Warming preview… {{done}}/{{total}}",
    bake_baking: "Pre-baking… {{done}}/{{total}}",
    bake_error: "Pre-bake failed",
    motif_install: "Install",
    motif_delete: "Delete",
    motif_delete_confirm: 'Delete Motif "{{id}}"? Placed clips will lose their content.',
    motif_status: { builtin: "Builtin", draft: "Draft", installed: "Installed" },
    motif_edit: "Edit",
    motif_edit_fork: "Duplicate & edit",
    motif_update: "Update",
    motif_save_as_new: "Save as new",
    motif_discard: "Discard",
    motif_confirm: "Confirm",
    motif_cancel: "Cancel",
    motif_update_confirm_one: "Used by 1 clip in this project. Updating changes it (and other projects update on next open).",
    motif_update_confirm_many: "Used by {{count}} clips in this project. Updating changes all of them (and other projects update on next open).",
    motif_source: "Source",
    motif_source_apply: "Apply",
    motif_source_applying: "Applying…",
    motif_source_hint: "Edit the Motif's HTML + manifest island, then Apply to update the preview.",
    transition: "Transition",
    direction: "Direction",
    transition_delete: "Delete transition",
  },
  captions: {
    title: "Captions",
    empty: "Import a subtitle file or transcribe a clip to create captions.",
    style_heading: "Style",
    // The two words beside the number fields; the aria-label below says what 0
    // does, because the field has no visible way to.
    size_label: "Size",
    outline_label: "Outline",
    outline_width: "Outline width (px), 0 for none",
    seek_to: "Go to caption at {{timecode}}",
  },
  audio_roles: { dialogue: "Dialogue", music: "Music", sfx: "SFX", voiceover: "Voiceover" },
  mixer: {
    title: "Mixer",
    gain_db: "{{role}} gain (dB)",
    gain_value: "{{value}} dB",
    gain_fader: "{{role}} gain fader",
    mute_hint: "Mute {{role}} everywhere",
    solo_hint: "Solo {{role}} (mutes the others)",
    implied_mute_badge: "Silenced",
    implied_mute_hint: "{{role}} is silent because another role is soloed",
    reset_hint: "Reset {{role}} gain to 0 dB",
    db_scale: "dB scale",
    role_meter: "{{role}} level meter",
    master: "Master",
    master_meter: "Master output meter",
    master_rms: "RMS {{value}}",
    master_peak: "Peak {{value}} dB",
    peak_hold: "Peak hold {{value}} dB, click to reset",
  },
  motif_picker: {
    heading: "Motifs",
    loading: "Loading motifs…",
    empty: "No motifs available.",
    preview_heading: "Preview",
    preview_canvas_size: "{{w}}×{{h}} canvas",
    preview_loading: "Loading preview…",
    props_heading: "Props",
    no_props: "(no editable props)",
    timing_heading: "Timing",
    insert_at: "Insert at",
    track_label: "Track",
    track_overlay_auto: "New track (auto-create)",
    duration_hint:
      "Clip length defaults to {{value}} (the motif's default duration). Trim later in the timeline if you need a different length.",
    add: "Add to timeline",
    adding: "Adding…",
    new_button: "New Motif",
    import_button: "Import Motif",
    untitled_name: "Untitled Motif",
    search_placeholder: "Search motifs…",
    search_clear: "Clear search",
    no_matches: "No motifs match “{{query}}”.",
    status: {
      draft: "Draft",
      installed: "Installed",
      builtin: "Built-in",
    },
  },
  status_bar: {
    label: "Activity log",
    empty: "No activity yet",
    toggle_label: "Logs",
    toggle_hint: "Show / hide activity log",
    source_user: "User",
    source_agent: "Agent · {{client}}",
    source_system: "System",
    error_badge_hint: "{{count}} error(s) — click to view",
    running_badge_hint: "{{count}} running operation(s) — click to view",
    announce_error_prefix: "Error",
    links_off: "Links off",
    links_off_hint: "Link override is on (Alt+Shift+G): edits act on single clips",
  },
  system_status: {
    trigger: "System {{count}}",
    trigger_hint: "{{count}} system status item(s) need attention",
    title: "System status",
    summary: "{{count}} item(s) need attention",
  },
  log: {
    level_filter: "Severity filter",
    level_all: "All",
    level_info: "Info+",
    level_warn: "Warn+",
    level_errorOnly: "Errors only",
    category_filter: "Category filter",
    category_Shortcut: "Shortcut",
    category_Mcp: "MCP",
    category_Job: "Job",
    category_Export: "Export",
    category_Import: "Import",
    category_Project: "Project",
    category_System: "System",
    category_Agent: "Agent",
    source_filter: "Source filter",
    source_User: "User",
    source_Agent: "Agent",
    source_System: "System",
    search_placeholder: "Search messages and details…",
    autoscroll_on: "Autoscroll: on",
    autoscroll_off: "Autoscroll: off",
    autoscroll_hint: "Toggle auto-scroll to newest entry",
    copy: "Copy",
    clear: "Clear",
    open_folder: "Open log folder",
    open_folder_unavailable_hint: "Open a workspace first.",
    close: "Close activity log",
    resize: "Resize console height",
    empty: "No entries match the current filters.",
    op_counter_hint: "Expand state changes for this op",
    toggle_details: "Toggle details",
    showing_of: "showing {{shown}} / {{total}}",
    op_state_Started: "Started",
    op_state_Ok: "Done",
    op_state_Err: "Failed",
    export_started: "Exporting {{path}}",
    export_ok: "Exported {{path}}",
    export_failed: "Export failed: {{error}}",
    export_cancelled: "Export cancelled",
    cleared: "Log cleared",
    center_layer_unstaged:
      "Cannot center a clip the preview has not staged yet — its size is unknown",
    cross_composition_copy:
      "A clip cannot be copied across timelines — release without Alt to move it there",
    paste_keyframes_no_target: "Select a clip to paste keyframes onto",
    paste_keyframes_skipped:
      "Skipped {{params}} — the selected clips do not carry it",
    auto_caption_started: "Transcribing “{{clip}}”",
    // Several clips are counted, not listed: their names are in the Caption
    // Panel the moment the cues land, and a row that named six clips would be a
    // paragraph. The failure row names the ONE clip that matters.
    auto_caption_started_many: "Transcribing {{count}} clips",
    auto_caption_done: "{{cues}} caption cues added ({{engine}})",
    auto_caption_failed: "Transcribing “{{clip}}” failed: {{reason}}",
    shots_analyze_started: "Analyzing shots in “{{clip}}”",
    // The CANDIDATE count, not a shot count: the scan's product is the
    // candidate list, and how many shots come out of it is whatever threshold
    // is read next.
    shots_analyze_done: "{{candidates}} shot candidates found in “{{clip}}”",
    // Only reached when the failure is not a structured refusal — a refusal
    // carries its own key and closes the op under that instead.
    shots_analyze_failed: "Shot analysis of “{{clip}}” failed: {{error}}",
    // The SPAN count both ways: it is what the pass costs (three ffmpeg
    // extracts each, for the spans no pass had measured) and what came back.
    shots_stats_started: "Measuring {{spans}} shots in “{{clip}}”",
    shots_stats_done: "{{spans}} shots measured in “{{clip}}”",
    // Only reached when the failure is not a structured refusal, as above.
    shots_stats_failed:
      "Measuring shots in “{{clip}}” failed: {{error}}",
    // One Started row per verb rather than one with the verb interpolated: a
    // discard announces two counts, and a translated sentence cannot carry an
    // untranslated verb name. The Started rows say how much of the review went
    // out; the terminal rows say what came back, which for a discard is
    // survivors and not the boundaries it cut at.
    shots_apply_split_started: "Splitting “{{clip}}” at {{cuts}} shot cuts",
    shots_apply_split_done: "“{{clip}}” split into {{segments}} segments",
    shots_apply_mark_started: "Marking {{cuts}} shot cuts in “{{clip}}”",
    shots_apply_mark_done:
      "{{markers}} shot cut markers added to “{{clip}}”",
    shots_apply_discard_started:
      "Splitting “{{clip}}” at {{cuts}} shot cuts, discarding {{discarded}} shots",
    shots_apply_discard_done:
      "{{segments}} segments kept from “{{clip}}”, {{discarded}} discarded",
    // Only reached when the failure is not a structured refusal — a refusal
    // closes the op under its own curated key instead.
    shots_apply_failed:
      "Applying shot cuts to “{{clip}}” failed: {{error}}",
    // Two terminal rows and not one with a flag, because the difference is what
    // the run COST: a cached hit billed nothing, and that is the fact worth
    // reading in the record.
    voiceover_started: "Generating voiceover — {{chars}} characters, {{voice}}",
    voiceover_done: "Voiceover added — {{chars}} characters, {{voice}}",
    voiceover_done_cached:
      "Voiceover added — reused cached audio, nothing billed",
    mark_pauses_started: "Marking pauses in “{{clip}}”",
    // The COUNT is the whole point of the row: the marks land in the ruler's
    // lower half, which the user may not have been looking at.
    mark_pauses_done: "{{markers}} pause markers added to “{{clip}}”",
    remove_pauses_started: "Removing pauses from “{{clip}}”",
    // The TOTAL beside the count, unlike the marking row's count alone: a
    // removal shortens the film, and how much it took out is what says how far
    // everything downstream moved. It is the sum of the CORES cut, not of the
    // pauses found — each one keeps its pad.
    remove_pauses_done:
      "{{removed}} pauses removed from “{{clip}}”, {{total}} in all",
    describe_started: "Describing “{{clip}}”",
    // The engine AND the model, unlike the transcription row's engine alone:
    // one runtime serves several vision models here, so the engine tag on its
    // own does not say which weights answered.
    describe_done:
      "{{segments}} described spans in “{{clip}}” ({{engine}}, {{model}})",
  },
  // Edit-stack row labels — one per `HISTORY_SUMMARY` entry in
  // main/state/history-labels.ts, which owns the English source text. The three
  // templated summaries (media.remove_cascade, audio.set_role_gain,
  // checkpoint.restore) take their `{{…}}` values from the entry's `label_args`;
  // history-labels.test.ts gates the placeholders against what each builder
  // actually supplies, so one can never render literally.
  history: {
    initial: "Initial",
    layer: {
      add: "Added clip",
      paste: "Pasted clip",
      duplicate: "Duplicated clip",
      paste_multi: "Duplicated {{count}} clips",
      enabled_multi: "Enabled {{count}} clips",
      disabled_multi: "Disabled {{count}} clips",
      move: "Moved clip",
      move_to_new_track: "Moved to a new track",
      // The named form wins whenever the destination carries a stored label;
      // the unnamed one covers a derived `Group N` and the root, neither of
      // which main can name.
      move_to_composition: "Moved {{count}} clips to {{composition}}",
      move_to_composition_unnamed: "Moved {{count}} clips elsewhere",
      restack: "Restacked clip",
      trim: "Trimmed clip",
      split: "Split clip",
      split_by_shots: "Split clip by shots",
      delete_multi: "Deleted clips",
      ripple_delete: "Ripple deleted clips",
      split_and_ripple: "Split clip and closed the gaps",
      update: "Updated clip",
      update_params: "Updated clip params",
      keyframe_param: "Keyframed clip param",
      keyframe_params: "Keyframed clip params",
      keyframe_params_multi: "Keyframed params across clips",
      scale_link: "Linked scale",
      scale_unlink: "Unlinked scale",
      separate_audio: "Separated audio",
      add_av_pair: "Added A/V pair",
      rebind_motif: "Rebound motif clips",
    },
    // A selected gap closed (ADR 0069): the subject is the gap, no clip went.
    gap: {
      close: "Closed gap",
    },
    track: {
      add: "Added track",
      delete: "Deleted track",
      move: "Moved track",
      rename: "Renamed track",
      add_caption: "Added captions",
    },
    marker: {
      add: "Added marker",
      add_shots: "Added shot markers",
      update: "Updated marker",
      remove: "Removed marker",
      attach: "Anchored marker to clip",
      detach: "Detached marker",
    },
    effect: {
      add: "Added effect",
      update: "Updated effect",
      reorder: "Reordered effect",
      remove: "Removed effect",
    },
    transition: {
      add: "Added transition",
      update: "Updated transition",
      remove: "Removed transition",
    },
    link: {
      create: "Created link",
      dissolve: "Dissolved link",
      add_members: "Added link members",
      remove_members: "Removed link members",
      rename: "Renamed link",
    },
    group: {
      create: "Grouped {{count}} clips",
      add_members: "Added {{count}} clips to Group",
      ungroup: "Ungrouped",
      rename: "Renamed Group",
    },
    composition: { delete: "Deleted Group" },
    caption: { restyle: "Restyled captions", correct: "Corrected caption text" },
    media: {
      remove_cascade:
        "Removed media {{media}} and {{count}} referencing clip(s)",
    },
    audio: { set_role_gain: "Set {{role}} role gain" },
    checkpoint: { restore: "Restored to checkpoint “{{label}}”" },
  },
  // The History Panel's own chrome. The ROW text comes from `history.*` above
  // (main records the key at commit time); everything here is panel furniture.
  history_panel: {
    // No "empty" string: the stack always holds at least the `Initial` seed and
    // the read cannot fail, so the only rowless moment is before the first
    // fetch settles.
    loading: "Loading history…",
    // Eviction header. Non-interactive: those snapshots are gone, so there is
    // nothing to jump to.
    evicted_one: "{{count}} earlier step is out of range",
    evicted_other: "{{count}} earlier steps are out of range",
    jump_hint: "Jump to this state",
    current_hint: "Current state",
    redo_hint: "Jump forward to this state",
    locked_hint: "History is locked: {{reason}}",
    actor_user: "You",
    agent_client: "Agent: {{client}}",
    group_steps_one: "{{count}} step",
    group_steps_other: "{{count}} steps",
    group_jump_hint: "Jump to the state before this run",
    // Boundary case: eviction ate the run's predecessor, so no stack index
    // holds "before this run" any more.
    group_jump_unavailable: "The state before this run is out of range",
    expand_group: "Show every step",
    collapse_group: "Collapse the run",
    // Joins entity names on a row and the counted phrases in a group header.
    list_separator: ", ",
    // Aggregate counting: `Split layer ×2, Added marker ×4`.
    aggregate_item: "{{label}} ×{{count}}",
    // ── Checkpoints (own section above the stack) ────────────────────────────
    checkpoints_title: "Checkpoints",
    // Load-bearing, not chrome: checkpoints are absent from serialize.ts /
    // persistence.ts and `replace_state` clears them, so a user reading them as
    // durable saves loses work.
    checkpoints_note: "This session only — checkpoints are cleared when the project closes.",
    checkpoints_empty: "No checkpoints yet. Use New to save the current state.",
    checkpoint_create: "New",
    checkpoint_create_hint: "Save the current state as a checkpoint",
    checkpoint_create_title: "New Checkpoint",
    checkpoint_create_confirm: "Create",
    checkpoint_cancel: "Cancel",
    checkpoint_label: "Name",
    checkpoint_label_placeholder: "Rough cut done",
    checkpoint_restore: "Restore",
    checkpoint_restore_hint: "Restore the state this checkpoint holds",
    checkpoint_delete: "Delete",
    checkpoint_delete_hint: "Delete this checkpoint",
    checkpoint_delete_title: "Delete checkpoint",
    checkpoint_delete_body: "Checkpoint “{{label}}” will be deleted.",
    // Whose checkpoint this is. The destructive case is cross-actor: an agent
    // session's `Pre-agent:` checkpoint may be that session's only way back, and
    // nothing else in the dialog says the checkpoint isn't yours.
    checkpoint_delete_owner_user: "You created this checkpoint.",
    checkpoint_delete_owner_agent: "Agent “{{client}}” created this checkpoint.",
    checkpoint_delete_note: "Deleting a checkpoint cannot be undone.",
    checkpoint_delete_confirm: "Delete",
    checkpoint_deleting: "Deleting…",
  },
  // Display labels for Rust-side enum discriminants. Keep keys lowercase so
  // `t("kinds." + value.toLowerCase())` works directly.
  kinds: {
    // MediaKind / TrackKind
    video: "Video",
    audio: "Audio",
    image: "Image",
    subtitle: "Subtitle",
    // LayerParams discriminants
    videoclip: "Video",
    imageoverlay: "Image",
    text: "Text",
    motif: "Motif",
    color: "Color",
    compositionref: "Group",
    // Markers have no kind discriminant; the history panel's entity-label chain
    // uses this as their last rung so a blank-labelled marker never renders as a
    // raw uuid (main/state/history-labels.ts).
    marker: "Marker",
  },
  // The voiceover dialog.
  voiceover: {
    title: "Voiceover",
    script: "Script",
    // Counter, always shown — an over-length script is refused here rather than
    // by the provider, so the number has to be visible before the limit is hit.
    script_count: "{{chars}} / {{max}} characters",
    script_empty: "type the script to be spoken",
    script_too_long: "{{over}} over the {{max}}-character limit for one voiceover",
    voice: "Voice",
    speed: "Speed",
    track: "Track",
    placement: "Where it lands",
    placement_append: "After everything else",
    placement_append_desc: "Starts at {{time}}, past the end of the timeline.",
    placement_playhead: "At the playhead",
    placement_playhead_desc: "Starts at {{time}}.",
    // Said before the button, not after the bill: this is the only entry in the
    // editor that spends money per use, and the cache is what makes a re-run of
    // the same script free.
    cost: "Generating new audio is a paid request. The same script, voice and speed reuses the audio already made, at no cost.",
    cancel: "Cancel",
    confirm: "Generate",
    running: "Generating…",
  },
  // The Pauses section of the Attribute Panel. Its home is a panel section and
  // not a dialog because tuning a threshold is something a person does WHILE
  // looking at the waveform and playing the clip (spec Decision 3), so the copy
  // here has to work in a narrow column beside the timeline rather than in a
  // form with room for hints.
  //
  // The UI word is PAUSE on every line here: a stretch of quiet inside speech
  // is what the feature is about, and the old noun collided with mute. The one
  // exception is the slider end below, where the phrase names the sound itself.
  pauses: {
    // Named on the delegating clip, so the user knows the numbers are not about
    // the picture they selected.
    delegated: "Measured on the linked audio “{{clip}}”",
    // Starting points, not modes: each sets the threshold and the minimum and
    // then gets out of the way. Named for the RECORDING, because that is what
    // the user knows about their own material — a dB figure is not.
    preset_speech: "Speech / podcast",
    preset_noisy: "Noisy room",
    preset_music: "Music / ambience",
    // A readout rather than a fourth choice: it lights to say the two numbers
    // below are the user's own.
    preset_custom: "Custom",
    threshold: "Threshold",
    // Decibels and not amplitude, unlike the tool's own parameter: 0..1 is
    // linear on a logarithmic quantity, so one step of it is 6 dB at the bottom
    // of the range and 0.4 dB at the top. The section converts.
    db: "{{db}} dB",
    // The two ends say what the directions MEAN. A dB number is a referent only
    // to someone who already knows the room.
    threshold_low: "true silence only",
    threshold_high: "allow room noise",
    // Measured from the clip's own peaks, which is what makes Auto worth a
    // button: it knows something about this recording that the user does not.
    noise_floor: "Noise floor ≈ {{db}} dB",
    auto: "Auto",
    min_length: "Shortest pause",
    // “Keep”, not “pad” or “trim”: the number is what SURVIVES on each side of a
    // pause, and a removal that erased them outright makes speech breathless.
    pad: "Keep each side",
    unit_ms: "ms",
    // Three numbers and no list: nobody confirms forty rows one by one. WHERE
    // the pauses are is answered by the bands on the clip, how it sounds by the
    // audition, and what it costs by this line.
    summary_one: "1 pause · removes {{removed}} · result {{result}}",
    summary_other: "{{count}} pauses · removes {{removed}} · result {{result}}",
    none: "No pauses at this threshold",
    detecting: "Reading the waveform…",
    // A state, not a failure: on a fresh import the peaks are still being
    // generated, and the section retries by itself once they are.
    waiting_waveform: "Waiting for the waveform…",
    // “Result”, because what plays is the stitched OUTCOME of a removal and not
    // the clip as it stands.
    audition: "Audition result",
    audition_stop: "Stop",
    mark: "Mark pauses",
    marking: "Marking…",
    remove: "Remove pauses",
    removing: "Removing…",
    // The parameters are remembered per project, so there has to be a way back.
    reset: "Reset to defaults",
  },
  search: {
    placeholder: "Search commands, media, clips, captions, descriptions…",
    no_results: "No results for “{{query}}”",
    group_command: "Commands",
    group_media: "Media",
    group_group: "Groups",
    group_track: "Tracks",
    group_clip: "Clips",
    group_caption: "Captions",
    group_marker: "Markers",
    group_description: "Descriptions",
    reveal_in_pool: "Reveal in media pool",
    unused: "Not on the timeline",
    missing_badge: "missing",
    show_more: "Show {{count}} more…",
  },
};

export default enUS;
export type Resources = typeof enUS;
