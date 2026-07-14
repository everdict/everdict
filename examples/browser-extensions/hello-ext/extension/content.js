// Content script — prefixes every page's title so a driver can observe the extension actually ran.
try { document.title = "EXT-LOADED:" + document.title; } catch (e) {}
