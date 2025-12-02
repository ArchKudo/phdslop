gh action to scrape phd listings built completly by sonnet 4.5
with this inital prompt:

convert this to a github action that runs weekly, make it robust, add tests, make it async, and publish the new csv in the repo, also if you're confident in doing it remove all rows that have empty columns, sort by latest deadline first, and store a verbose log of all output as well in the repo:

```
const base = "https://www.findaphd.com/phds/united-kingdom/bioinformatics/non-eu-students/?j1M78yYM440&Show=M&Sort=I&PG=";
const collected = [];

for (let p = 1; p <= 16; p++) {
  const res = await fetch(base + p);
  const html = await res.text();
  const doc = new DOMParser().parseFromString(html, "text/html");

  const blocks = [...doc.querySelectorAll("div.col-md-18")];

  blocks.forEach(b => {
    const title = b.querySelector("span.h4")?.innerText.trim() || "";
    const uni = b.querySelector(".col-24.instLink span")?.innerText.trim() || "";
    const deadline = b.querySelector("span:nth-of-type(1) span.col-xs-24")?.innerText.trim() || "";

    collected.push({ title, uni, deadline });
  });
}

let csv = "title,uni,deadline\n";

csv += collected
.map(r =>
  [
    `"${r.title.replace(/"/g, '""')}"`,
    `"${r.uni.replace(/"/g, '""')}"`,
    `"${r.deadline.replace(/"/g, '""')}"`
  ].join(",")
)
.join("\n");
```

License
MIT Slop license
