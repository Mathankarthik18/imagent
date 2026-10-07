import { Link, useSearchParams } from "react-router-dom";
import { CompareView } from "../components/CompareView";
import { CopyId, Empty, PageHeader } from "../components/ui";

export function Compare() {
  const [params] = useSearchParams();
  const a = params.get("a") ?? "";
  const b = params.get("b") ?? "";
  return (
    <div>
      <nav className="mb-2 text-[12.5px] text-ink-3"><Link to="/traces?view=list" className="hover:text-ink">Traces</Link> / Compare</nav>
      <PageHeader title="Compare runs" meta={a && b ? <span className="inline-flex gap-2">A <CopyId value={a} display={a.slice(0, 8)} /> · B <CopyId value={b} display={b.slice(0, 8)} /></span> : undefined} />
      {a && b ? <CompareView a={a} b={b} labels={["A · baseline", "B · candidate"]} /> : (
        <Empty title="Pick two runs to compare" hint="In Traces → All runs, tick two runs and choose Compare." />
      )}
    </div>
  );
}
