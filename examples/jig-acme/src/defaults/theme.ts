// Defaults for `theme`. A real company puts here its palette, so that its people can pick it with `/theme`.
//
// A palette starts as a copy of one of Jig's six (`base`) and changes the named colours (`vars`). This one is `jig-signal` with
// Acme's orange as the accent. Defaults only offer the palette: nobody's theme changes until they choose it.
export const themeDefaults = {
    palettes: {
        acme: { base: "jig-signal", vars: { accent: "#F26B3A", heading: "#FFB454" } },
    },
};
