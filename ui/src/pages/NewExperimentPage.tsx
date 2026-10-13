import { useNavigate, useSearchParams } from "react-router-dom";
import { NewExperiment } from "../components/NewExperiment";
import { pp } from "../lib/project";

/** /experiments/new?sources=a,b&root=agent&focus=sub_agent */
export function NewExperimentPage() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  return (
    <NewExperiment
      preselected={(params.get("sources") ?? "").split(",").filter(Boolean)}
      rootName={params.get("root") ?? undefined}
      focusAgent={params.get("focus") ?? undefined}
      onClose={() => navigate(pp("/experiments"))} />
  );
}
