using System.Text.Json.Serialization;

namespace NkmrWahoo.Web.Models
{
    public class MyWhooshWorkout
    {
        public string Id { get; set; } = Guid.NewGuid().ToString();
        public string Name { get; set; } = "Sans titre";
        public string Description { get; set; } = "";
        public string Mode { get; set; } = "E_Ride";
        public int Time { get; set; }
        public int StepCount { get; set; }
        public double? IF { get; set; }
        public double? TSS { get; set; }
        public double? KJ { get; set; }
        public string AuthorName { get; set; } = "";

        [JsonPropertyName("WorkoutStepsArray")]
        public List<WorkoutStep> WorkoutStepsArray { get; set; } = new();

        [JsonIgnore]
        public string FormattedTotalTime => $"{Time / 60}m {Time % 60:D2}s";
    }

    public class WorkoutStep
    {
        public int Id { get; set; }
        public int IntervalId { get; set; }
        public string StepType { get; set; } = "E_Normal";
        public int Time { get; set; }
        public double Power { get; set; }
        public double StartPower { get; set; }
        public double EndPower { get; set; }
        public int Rpm { get; set; }
        public List<WorkoutMessage> WorkoutMessage { get; set; } = new();

        [JsonIgnore]
        public bool IsRamp => (StartPower > 0 || EndPower > 0) && Power == 0;

        public double GetTargetPowerRatio(int elapsedInStep)
        {
            if (IsRamp && Time > 0)
            {
                double progress = Math.Clamp((double)elapsedInStep / Time, 0.0, 1.0);
                return StartPower + (EndPower - StartPower) * progress;
            }
            return Power;
        }

        public string GetZoneName(double ratio)
        {
            if (ratio < 0.55) return "Z1 - Récupération";
            if (ratio < 0.75) return "Z2 - Endurance";
            if (ratio < 0.90) return "Z3 - Tempo";
            if (ratio < 1.05) return "Z4 - Seuil";
            if (ratio < 1.20) return "Z5 - VO2 Max";
            return "Z6 - Anaérobie";
        }

        public string GetZoneColor(double ratio)
        {
            if (ratio < 0.55) return "#94a3b8"; // Slate / Gris
            if (ratio < 0.75) return "#38bdf8"; // Bleu clair
            if (ratio < 0.90) return "#22c55e"; // Vert
            if (ratio < 1.05) return "#eab308"; // Jaune
            if (ratio < 1.20) return "#f97316"; // Orange
            return "#ef4444"; // Rouge
        }
    }

    public class WorkoutMessage
    {
        public int Id { get; set; }
        public int Time { get; set; }
        public string Message { get; set; } = "";
    }
}
