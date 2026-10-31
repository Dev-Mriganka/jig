// Defaults for `git`. A real company puts here its branch and commit conventions, so that a branch or a pull request that breaks
// them is refused before anything is sent.
//
// Patterns are regular expressions. A branch name or a title is tested whole, so anchor it with `^`. Setting `protected` replaces the
// repository's default branch, so name it too.
export const gitDefaults = {
    base: "main",
    protected: ["main", "release/*"],
    branchName: "^(feature|fix)/ACME-\\d+",
    prTitle: "^ACME-\\d+: ",
};
