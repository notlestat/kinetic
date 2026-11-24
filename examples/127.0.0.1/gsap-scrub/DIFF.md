# Preview diff

Rendered 2026-11-24T21:21:14.952Z. Threshold: 10.0% of pixels. Over the threshold in 1 of 2 states.

| state | score | size (original → rebuild) | original | rebuild | diff |
| --- | --- | --- | --- | --- | --- |
| default | 22.4% (over) | 1288×976 → 1288×976 | ![states/default.png](states/default.png) | ![preview/default.png](preview/default.png) | ![diff/default.png](diff/default.png) |
| mobile | 4.7% | 796×2058 → 788×2058 | ![states/mobile.png](states/mobile.png) | ![preview/mobile.png](preview/mobile.png) | ![diff/mobile.png](diff/mobile.png) |

Score is the share of pixels that differ (pixelmatch, colour tolerance 0.1) on a canvas the size of the larger image, so a size difference counts as mismatch. Red pixels in each diff image mark the mismatches. Screenshots are the component's box plus 8 px, with each state forced on the same element as in the original. The rebuild is laid out at the original root's width (and, for mobile, at the width it had in a 390 px viewport).

Compare the motion too: [original.webm](original.webm) and [Component.preview.webm](Component.preview.webm).
