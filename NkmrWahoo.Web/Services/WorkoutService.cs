using System.Text.Json;
using NkmrWahoo.Web.Models;

namespace NkmrWahoo.Web.Services
{
    public interface IWorkoutService
    {
        Task<List<MyWhooshWorkout>> GetWorkoutsAsync();
        Task<MyWhooshWorkout?> GetWorkoutByIdAsync(string id);
        Task SaveWorkoutAsync(MyWhooshWorkout workout);
        Task DeleteWorkoutAsync(string id);
        Task<MyWhooshWorkout?> ImportFromJsonAsync(string jsonContent);
        Task<int> GetFtpAsync();
        Task SetFtpAsync(int ftp);
        Task ResetToSampleWorkoutAsync();
    }

    public class WorkoutService : IWorkoutService
    {
        private const string WorkoutsStorageKey = "SavedWorkouts";
        private const string FtpStorageKey = "UserFTP";
        private readonly ILocalStorageService _localStorage;

        public WorkoutService(ILocalStorageService localStorage)
        {
            _localStorage = localStorage;
        }

        public async Task<int> GetFtpAsync()
        {
            var ftp = await _localStorage.GetItemAsync<int?>(FtpStorageKey);
            return (ftp.HasValue && ftp.Value > 50) ? ftp.Value : 200; // 200W par défaut
        }

        public async Task SetFtpAsync(int ftp)
        {
            if (ftp < 50) ftp = 50;
            if (ftp > 600) ftp = 600;
            await _localStorage.SetItemAsync(FtpStorageKey, ftp);
        }

        public async Task<List<MyWhooshWorkout>> GetWorkoutsAsync()
        {
            var workouts = await _localStorage.GetItemAsync<List<MyWhooshWorkout>>(WorkoutsStorageKey);
            if (workouts == null || workouts.Count == 0)
            {
                // Injecter l'entraînement d'exemple MyWhoosh Hard Starts 2
                var sample = GetSampleHardStartsWorkout();
                workouts = new List<MyWhooshWorkout> { sample };
                await _localStorage.SetItemAsync(WorkoutsStorageKey, workouts);
            }
            return workouts;
        }

        public async Task<MyWhooshWorkout?> GetWorkoutByIdAsync(string id)
        {
            var workouts = await GetWorkoutsAsync();
            return workouts.FirstOrDefault(w => w.Id == id);
        }

        public async Task SaveWorkoutAsync(MyWhooshWorkout workout)
        {
            var workouts = await GetWorkoutsAsync();
            var existingIndex = workouts.FindIndex(w => w.Id == workout.Id);
            if (existingIndex >= 0)
            {
                workouts[existingIndex] = workout;
            }
            else
            {
                workouts.Add(workout);
            }
            await _localStorage.SetItemAsync(WorkoutsStorageKey, workouts);
        }

        public async Task DeleteWorkoutAsync(string id)
        {
            var workouts = await GetWorkoutsAsync();
            workouts.RemoveAll(w => w.Id == id);
            await _localStorage.SetItemAsync(WorkoutsStorageKey, workouts);
        }

        public async Task<MyWhooshWorkout?> ImportFromJsonAsync(string jsonContent)
        {
            try
            {
                var options = new JsonSerializerOptions
                {
                    PropertyNameCaseInsensitive = true
                };
                var workout = JsonSerializer.Deserialize<MyWhooshWorkout>(jsonContent, options);
                if (workout != null && workout.WorkoutStepsArray.Count > 0)
                {
                    if (string.IsNullOrWhiteSpace(workout.Id))
                    {
                        workout.Id = Guid.NewGuid().ToString();
                    }
                    if (workout.Time <= 0)
                    {
                        workout.Time = workout.WorkoutStepsArray.Sum(s => s.Time);
                    }
                    workout.StepCount = workout.WorkoutStepsArray.Count;
                    await SaveWorkoutAsync(workout);
                    return workout;
                }
            }
            catch (Exception ex)
            {
                Console.WriteLine($"Erreur parsing JSON MyWhoosh : {ex.Message}");
            }
            return null;
        }

        public async Task ResetToSampleWorkoutAsync()
        {
            var sample = GetSampleHardStartsWorkout();
            await _localStorage.SetItemAsync(WorkoutsStorageKey, new List<MyWhooshWorkout> { sample });
        }

        private static MyWhooshWorkout GetSampleHardStartsWorkout()
        {
            return new MyWhooshWorkout
            {
                Id = "2037424",
                Name = "hard-starts-2.zwo",
                Description = "MyWhoosh - Hard Starts 2 (Course & intensité)",
                Mode = "E_Ride",
                Time = 1930,
                StepCount = 30,
                IF = 0.911,
                TSS = 44.53,
                KJ = 300.53,
                AuthorName = "MyWhoosh",
                WorkoutStepsArray = new List<WorkoutStep>
                {
                    new WorkoutStep
                    {
                        Id = 1, StepType = "E_WarmUp", Time = 180, StartPower = 0.45, EndPower = 0.70,
                        WorkoutMessage = new List<WorkoutMessage>
                        {
                            new WorkoutMessage { Id = 1, Time = 0, Message = "Aujourd'hui, nous reproduisons l'effort d'un départ de course difficile." },
                            new WorkoutMessage { Id = 2, Time = 30, Message = "Un bon entraînement commence toujours par un bon échauffement !" }
                        }
                    },
                    new WorkoutStep { Id = 2, StepType = "E_Normal", Time = 10, Power = 1.31 },
                    new WorkoutStep { Id = 3, StepType = "E_Normal", Time = 50, Power = 0.50 },
                    new WorkoutStep { Id = 4, StepType = "E_Normal", Time = 10, Power = 1.31 },
                    new WorkoutStep { Id = 5, StepType = "E_Normal", Time = 50, Power = 0.50 },
                    new WorkoutStep { Id = 6, StepType = "E_Normal", Time = 120, Power = 0.80 },
                    new WorkoutStep
                    {
                        Id = 7, StepType = "E_Normal", Time = 60, Power = 0.50,
                        WorkoutMessage = new List<WorkoutMessage>
                        {
                            new WorkoutMessage { Id = 1, Time = 0, Message = "Montée en zone 3, déliez bien les jambes !" }
                        }
                    },
                    new WorkoutStep { Id = 8, StepType = "E_Normal", Time = 60, Power = 1.09 },
                    new WorkoutStep
                    {
                        Id = 9, StepType = "E_Normal", Time = 120, Power = 0.50,
                        WorkoutMessage = new List<WorkoutMessage>
                        {
                            new WorkoutMessage { Id = 1, Time = 0, Message = "Petite incursion en zone 5." }
                        }
                    },
                    new WorkoutStep
                    {
                        Id = 10, StepType = "E_Normal", Time = 180, Power = 1.0,
                        WorkoutMessage = new List<WorkoutMessage>
                        {
                            new WorkoutMessage { Id = 1, Time = 0, Message = "Cadence rapide et fluide !" }
                        }
                    },
                    new WorkoutStep
                    {
                        Id = 11, StepType = "E_Normal", Time = 90, Power = 0.62,
                        WorkoutMessage = new List<WorkoutMessage>
                        {
                            new WorkoutMessage { Id = 1, Time = 0, Message = "Fin de l'échauffement, préparez-vous pour les intervalles principaux." }
                        }
                    },
                    new WorkoutStep { Id = 12, StepType = "E_Normal", Time = 30, Power = 1.40 },
                    new WorkoutStep { Id = 13, StepType = "E_Normal", Time = 20, Power = 0.60 },
                    new WorkoutStep { Id = 14, StepType = "E_Normal", Time = 30, Power = 1.40 },
                    new WorkoutStep { Id = 15, StepType = "E_Normal", Time = 20, Power = 0.60 },
                    new WorkoutStep { Id = 16, StepType = "E_Normal", Time = 30, Power = 1.40 },
                    new WorkoutStep { Id = 17, StepType = "E_Normal", Time = 20, Power = 0.60 },
                    new WorkoutStep { Id = 18, StepType = "E_Normal", Time = 30, Power = 1.40 },
                    new WorkoutStep { Id = 19, StepType = "E_Normal", Time = 20, Power = 0.60 },
                    new WorkoutStep { Id = 20, StepType = "E_Normal", Time = 120, Power = 0.95 },
                    new WorkoutStep { Id = 21, StepType = "E_Normal", Time = 60, Power = 1.10 },
                    new WorkoutStep { Id = 22, StepType = "E_Normal", Time = 45, Power = 0.60 },
                    new WorkoutStep
                    {
                        Id = 23, StepType = "E_Normal", Time = 90, Power = 0.95,
                        WorkoutMessage = new List<WorkoutMessage>
                        {
                            new WorkoutMessage { Id = 1, Time = 0, Message = "Maintenez le tempo dans le groupe de tête !" }
                        }
                    },
                    new WorkoutStep { Id = 24, StepType = "E_Normal", Time = 45, Power = 1.19 },
                    new WorkoutStep { Id = 25, StepType = "E_Normal", Time = 30, Power = 0.60 },
                    new WorkoutStep
                    {
                        Id = 26, StepType = "E_Normal", Time = 60, Power = 0.95,
                        WorkoutMessage = new List<WorkoutMessage>
                        {
                            new WorkoutMessage { Id = 1, Time = 0, Message = "Tenir au seuil, restez concentré !" }
                        }
                    },
                    new WorkoutStep { Id = 27, StepType = "E_Normal", Time = 20, Power = 1.31 },
                    new WorkoutStep { Id = 28, StepType = "E_Normal", Time = 90, Power = 0.75 },
                    new WorkoutStep { Id = 29, StepType = "E_WarmUp", Time = 120, StartPower = 0.55, EndPower = 1.20 },
                    new WorkoutStep { Id = 30, StepType = "E_CoolDown", Time = 120, StartPower = 1.20, EndPower = 0.55 }
                }
            };
        }
    }
}
